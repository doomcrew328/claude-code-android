#!/usr/bin/env python3
"""fwextract.py: extract Android firmware on an Android phone (Termux).

One file, Python 3.8+ standard library only. Optional speed-ups are used
when present (the `lz4`, `zstd` and `brotli` command-line tools, or the
matching Python modules) but nothing beyond `pkg install python` is
required for the common cases.

Why Python and not a shell script: every format here is a binary container
(protobuf manifests, chunked sparse images, LP metadata tables, boot image
headers). Parsing those in bash would mean shelling out to a dozen tools
that Termux does not ship (payload-dumper-go, simg2img, lpunpack,
unpackbootimg). Python's stdlib already has zipfile, tarfile, bz2, lzma,
zlib and struct, which covers almost everything with no extra packages.

What it understands (detected by magic bytes, not file names):

  OTA / factory zip     extracts payload.bin straight out of the zip
                        without unpacking the whole archive first
  payload.bin           A/B full OTA (REPLACE, REPLACE_BZ, REPLACE_XZ,
                        REPLACE_ZSTD, ZERO, DISCARD operations)
  Android sparse image  -> raw image (also Motorola *_sparsechunk.N sets)
  super.img             dynamic partitions (LP metadata) -> system.img,
                        vendor.img, product.img, ...
  boot / init_boot /    kernel, ramdisk (decompressed and unpacked),
  vendor_boot           dtb, second, recovery_dtbo, header info
  Samsung .tar/.tar.md5 and the *.img.lz4 files inside them
  block-based OTA       *.transfer.list + *.new.dat(.br) -> raw image
  .lz4 .zst .gz .xz     decompressed, then inspected again
  ext4 / erofs          optional, via debugfs / fsck.erofs if installed

Containers are followed recursively: a Samsung AP tar becomes super.img.lz4,
then super.img (sparse), then raw super, then system.img, vendor.img, ...

Usage:
  python fwextract.py FIRMWARE [-o OUTDIR] [-p boot,init_boot] [--list]
                      [--unpack-boot] [--unpack-fs] [--verify] [--keep]

Exit codes: 0 success, 1 fatal error, 2 finished with some items failed.
"""

import argparse
import bz2
import contextlib
import hashlib
import io
import lzma
import os
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import zipfile
import zlib

__version__ = "1.0.0"

BUF = 4 * 1024 * 1024  # copy buffer; small enough for low-RAM phones


class FwError(Exception):
    pass


# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------

QUIET = False


def log(msg=""):
    if not QUIET:
        print(msg, flush=True)


def warn(msg):
    print("warning: " + msg, file=sys.stderr, flush=True)


def human(n):
    n = float(n)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if abs(n) < 1024 or unit == "GiB":
            return ("%d %s" % (n, unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n /= 1024
    return "%.1f GiB" % n


class Progress:
    """Single-line progress on a terminal; silent when piped."""

    def __init__(self, label, total):
        self.label = label
        self.total = max(total, 1)
        self.done = 0
        self.last = -1
        self.tty = sys.stdout.isatty() and not QUIET

    def add(self, n):
        self.done += n
        if not self.tty:
            return
        pct = min(100, self.done * 100 // self.total)
        if pct != self.last:
            self.last = pct
            sys.stdout.write("\r  %-28s %3d%%" % (self.label, pct))
            sys.stdout.flush()

    def finish(self, note=""):
        if self.tty:
            sys.stdout.write("\r" + " " * 40 + "\r")
        log("  %-28s %10s  %s" % (self.label, human(self.total), note))


def copy_range(src, src_off, dst, dst_off, length, progress=None):
    src.seek(src_off)
    dst.seek(dst_off)
    left = length
    while left > 0:
        chunk = src.read(min(BUF, left))
        if not chunk:
            raise FwError("unexpected end of file while copying")
        dst.write(chunk)
        left -= len(chunk)
        if progress:
            progress.add(len(chunk))


@contextlib.contextmanager
def removed_on_error(path):
    """Delete a half-written output if anything (even Ctrl-C) interrupts it."""
    try:
        yield
    except BaseException:
        try:
            os.remove(path)
        except OSError:
            pass
        raise


IN_TERMUX = os.environ.get("PREFIX", "").startswith("/data/data/com.termux")

# How to get each optional tool. In Termux, erofs-utils lives in root-repo,
# which installs without root.
_INSTALL = {
    "lz4": ("pkg install lz4", "apt install lz4"),
    "zstd": ("pkg install zstd", "apt install zstd"),
    "brotli": ("pkg install brotli", "apt install brotli"),
    "debugfs": ("pkg install e2fsprogs", "apt install e2fsprogs"),
    "fsck.erofs": ("pkg install root-repo && pkg install erofs-utils", "apt install erofs-utils"),
}


def install_hint(tool):
    termux, apt = _INSTALL[tool]
    cmd = termux if IN_TERMUX else apt
    return "%s (or run tools/setup-fwextract.sh once)" % cmd


def have(tool):
    return shutil.which(tool) is not None


def safe_join(base, name):
    """Join an archive member name under base, refusing path traversal."""
    name = name.replace("\\", "/").lstrip("/")
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return os.path.join(base, *parts)


def check_space(outdir, needed):
    try:
        free = shutil.disk_usage(outdir).free
    except OSError:
        return
    if needed > free:
        warn("this needs about %s but only %s is free in %s; use -p to pick "
             "fewer partitions" % (human(needed), human(free), outdir))


# --------------------------------------------------------------------------
# Decompression: stdlib first, then optional modules, then CLI tools
# --------------------------------------------------------------------------

class _CliDecompressor:
    """Buffers a whole stream and pipes it through a CLI tool on flush.

    Only used for per-operation payload blobs (a few MiB each), never for
    whole multi-GB files; those go through decompress_file().
    """

    def __init__(self, argv):
        self.argv = argv
        self.buf = []

    def decompress(self, data):
        self.buf.append(data)
        return b""

    def flush(self):
        r = subprocess.run(self.argv, input=b"".join(self.buf),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if r.returncode != 0:
            raise FwError("%s failed: %s" % (self.argv[0], r.stderr.decode(errors="replace").strip()))
        return r.stdout


class _Identity:
    def decompress(self, data):
        return data

    def flush(self):
        return b""


class _StdlibWrap:
    def __init__(self, d):
        self.d = d

    def decompress(self, data):
        return self.d.decompress(data)

    def flush(self):
        f = getattr(self.d, "flush", None)
        return f() if f else b""


def zstd_decompressor():
    try:  # Python 3.14+
        from compression import zstd as _z  # type: ignore
        return _StdlibWrap(_z.ZstdDecompressor())
    except ImportError:
        pass
    try:
        import zstandard  # type: ignore
        return _StdlibWrap(zstandard.ZstdDecompressor().decompressobj())
    except ImportError:
        pass
    if have("zstd"):
        return _CliDecompressor(["zstd", "-dcq"])
    raise FwError("zstd data found; install it with: " + install_hint("zstd"))


def brotli_decompressor():
    try:
        import brotli  # type: ignore
        d = brotli.Decompressor()
        proc = getattr(d, "process", None) or getattr(d, "decompress")

        class _B:
            def decompress(self, data):
                return proc(data)

            def flush(self):
                return b""
        return _B()
    except ImportError:
        pass
    if have("brotli"):
        return _CliDecompressor(["brotli", "-dc"])
    raise FwError("brotli data found; install it with: " + install_hint("brotli"))


# ---- LZ4 (pure-Python fallback; Android ramdisks are usually lz4-legacy) ----

LZ4_FRAME_MAGIC = 0x184D2204
LZ4_LEGACY_MAGIC = 0x184C2102


def lz4_block(src, prefix=b""):
    """Decode one raw LZ4 block. `prefix` is the history window for linked blocks."""
    dst = bytearray(prefix)
    base = len(prefix)
    i, n = 0, len(src)
    while i < n:
        token = src[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        dst += src[i:i + lit]
        i += lit
        if i >= n:
            break
        off = src[i] | (src[i + 1] << 8)
        i += 2
        ml = token & 15
        if ml == 15:
            while True:
                b = src[i]
                i += 1
                ml += b
                if b != 255:
                    break
        ml += 4
        start = len(dst) - off
        if off == 0 or start < 0:
            raise FwError("corrupt lz4 data")
        if off >= ml:
            dst += dst[start:start + ml]
        else:  # overlapping match: the window repeats
            pat = bytes(dst[start:])
            dst += (pat * (ml // off + 1))[:ml]
    return bytes(dst[base:])


def _lz4_block_fast(data, max_size):
    try:
        import lz4.block  # type: ignore
        return lz4.block.decompress(data, uncompressed_size=max_size)
    except ImportError:
        return lz4_block(data)


def lz4_stream(fin, fout, limit=None, progress=None):
    """Decode lz4 frame or legacy streams from fin into fout (pure Python)."""
    end = None if limit is None else fin.tell() + limit

    def read(k):
        if end is not None:
            k = min(k, end - fin.tell())
        return fin.read(k) if k > 0 else b""

    while True:
        mb = read(4)
        if len(mb) < 4:
            return
        magic = struct.unpack("<I", mb)[0]
        if magic == LZ4_LEGACY_MAGIC:
            while True:
                hb = read(4)
                if len(hb) < 4:
                    return
                size = struct.unpack("<I", hb)[0]
                if size == LZ4_LEGACY_MAGIC:
                    continue
                if size == 0 or size > (16 << 20):
                    return  # padding or trailing data after the stream
                blk = read(size)
                fout.write(_lz4_block_fast(blk, 8 << 20))
                if progress:
                    progress.add(size + 4)
        elif magic == LZ4_FRAME_MAGIC:
            flg, bd = read(2)
            if flg & 0x08:
                read(8)
            if flg & 0x01:
                read(4)
            read(1)  # header checksum
            linked = not (flg & 0x20)
            block_ck = flg & 0x10
            max_block = 1 << (8 + 2 * ((bd >> 4) & 7))
            window = b""
            while True:
                size = struct.unpack("<I", read(4))[0]
                if size == 0:
                    break
                raw = size & 0x80000000
                size &= 0x7FFFFFFF
                blk = read(size)
                if block_ck:
                    read(4)
                if raw:
                    out = blk
                elif linked and window:
                    out = lz4_block(blk, window)
                else:
                    out = _lz4_block_fast(blk, max_block)
                fout.write(out)
                if linked:
                    window = (window + out)[-65536:]
                if progress:
                    progress.add(size + 4)
            if flg & 0x04:
                read(4)  # content checksum
        elif 0x184D2A50 <= magic <= 0x184D2A5F:  # skippable frame
            read(struct.unpack("<I", read(4))[0])
        else:
            return


def decompress_file(kind, src, dst, label):
    """Decompress a whole file (possibly many GB) with bounded memory."""
    with removed_on_error(dst):
        _decompress_file(kind, src, dst, label)


def _decompress_file(kind, src, dst, label):
    total = os.path.getsize(src)
    prog = Progress(label, total)
    cli = {"lz4": ["lz4", "-dcq"], "zstd": ["zstd", "-dcq"],
           "gzip": ["gzip", "-dc"], "xz": ["xz", "-dc"], "bzip2": ["bzip2", "-dc"]}
    # Native tools are far faster than pure Python for multi-GB lz4 images.
    if kind in ("lz4", "zstd") and have(cli[kind][0]):
        with open(src, "rb") as fi, open(dst, "wb") as fo:
            r = subprocess.run(cli[kind], stdin=fi, stdout=fo, stderr=subprocess.PIPE)
        if r.returncode != 0:
            raise FwError("%s failed: %s" % (kind, r.stderr.decode(errors="replace").strip()))
        prog.add(total)
        prog.total = os.path.getsize(dst)
        prog.finish("decompressed (%s)" % kind)
        return
    with open(src, "rb") as fi, open(dst, "wb") as fo:
        if kind == "lz4":
            try:
                import lz4.frame  # type: ignore
                head = fi.read(4)
                fi.seek(0)
                if struct.unpack("<I", head)[0] != LZ4_FRAME_MAGIC:
                    raise ImportError  # legacy format: module has no stream API
                d = lz4.frame.LZ4FrameDecompressor()
                while True:
                    chunk = fi.read(BUF)
                    if not chunk:
                        break
                    while chunk:
                        fo.write(d.decompress(chunk))
                        chunk = d.unused_data if d.eof else b""
                        if d.eof:
                            d = lz4.frame.LZ4FrameDecompressor()
                    prog.add(BUF)
            except ImportError:
                if total > (256 << 20):
                    warn("decoding %s of lz4 in pure Python is slow; "
                         "%s makes this much faster" % (human(total), install_hint("lz4")))
                fi.seek(0)
                lz4_stream(fi, fo, progress=prog)
        else:
            if kind == "gzip":
                d = _StdlibWrap(zlib.decompressobj(16 + zlib.MAX_WBITS))
            elif kind == "xz":
                d = _StdlibWrap(lzma.LZMADecompressor())
            elif kind == "bzip2":
                d = _StdlibWrap(bz2.BZ2Decompressor())
            elif kind == "zstd":
                d = zstd_decompressor()
            elif kind == "brotli":
                d = brotli_decompressor()
            else:
                raise FwError("unknown compression " + kind)
            while True:
                chunk = fi.read(BUF)
                if not chunk:
                    break
                fo.write(d.decompress(chunk))
                prog.add(len(chunk))
            fo.write(d.flush())
    prog.total = os.path.getsize(dst)
    prog.finish("decompressed (%s)" % kind)


def decompress_bytes(data):
    """Decompress a small in-memory blob (ramdisks). Returns (bytes, format)."""
    m = data[:6]
    if m[:2] == b"\x1f\x8b":
        return zlib.decompress(data, 16 + zlib.MAX_WBITS), "gzip"
    if m[:6] == b"\xfd7zXZ\x00":
        return lzma.decompress(data), "xz"
    if m[:3] == b"\x5d\x00\x00":
        return lzma.decompress(data, format=lzma.FORMAT_ALONE), "lzma"
    if m[:3] == b"BZh":
        return bz2.decompress(data), "bzip2"
    if m[:4] == b"\x28\xb5\x2f\xfd":
        d = zstd_decompressor()
        return d.decompress(data) + d.flush(), "zstd"
    if len(data) >= 4 and struct.unpack("<I", data[:4])[0] in (LZ4_FRAME_MAGIC, LZ4_LEGACY_MAGIC):
        out = io.BytesIO()
        lz4_stream(io.BytesIO(data), out)
        return out.getvalue(), "lz4"
    return data, "raw"


# --------------------------------------------------------------------------
# Minimal protobuf reader (enough for update_engine's DeltaArchiveManifest)
# --------------------------------------------------------------------------

def _varint(buf, i):
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def pb_fields(buf):
    out = {}
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(buf, i)
        elif wt == 1:
            v = struct.unpack_from("<Q", buf, i)[0]
            i += 8
        elif wt == 2:
            ln, i = _varint(buf, i)
            v = bytes(buf[i:i + ln])
            i += ln
        elif wt == 5:
            v = struct.unpack_from("<I", buf, i)[0]
            i += 4
        else:
            raise FwError("unsupported protobuf wire type %d" % wt)
        out.setdefault(fn, []).append(v)
    return out


def _one(fields, n, default=None):
    v = fields.get(n)
    return v[0] if v else default


# --------------------------------------------------------------------------
# payload.bin (A/B OTA)
# --------------------------------------------------------------------------

OP_NAMES = {0: "REPLACE", 1: "REPLACE_BZ", 2: "MOVE", 3: "BSDIFF", 4: "SOURCE_COPY",
            5: "SOURCE_BSDIFF", 6: "ZERO", 7: "DISCARD", 8: "REPLACE_XZ", 9: "PUFFDIFF",
            10: "BROTLI_BSDIFF", 11: "ZUCCHINI", 12: "LZ4DIFF_BSDIFF",
            13: "LZ4DIFF_PUFFDIFF", 14: "REPLACE_ZSTD"}
OP_REPLACE, OP_BZ, OP_ZERO, OP_DISCARD, OP_XZ, OP_ZSTD = 0, 1, 6, 7, 8, 14
FULL_OPS = {OP_REPLACE, OP_BZ, OP_ZERO, OP_DISCARD, OP_XZ, OP_ZSTD}


class Payload:
    def __init__(self, path, base=0, label=None):
        self.path, self.base = path, base
        self.label = label or path
        with open(path, "rb") as f:
            f.seek(base)
            hdr = f.read(20)
            if len(hdr) < 20 or hdr[:4] != b"CrAU":
                raise FwError("not a payload.bin (bad magic)")
            version, msize = struct.unpack(">QQ", hdr[4:20])
            sigsize = 0
            hlen = 20
            if version >= 2:
                sigsize = struct.unpack(">I", f.read(4))[0]
                hlen = 24
            avail = os.path.getsize(path) - base - hlen
            if msize > avail or sigsize > avail or msize > (512 << 20):
                raise FwError("payload header is corrupt or the file is incomplete "
                              "(manifest says %d bytes)" % msize)
            manifest = f.read(msize)
        self.data_offset = base + hlen + msize + sigsize
        m = pb_fields(manifest)
        self.block_size = _one(m, 3, 4096)
        self.minor_version = _one(m, 12, 0)
        self.partitions = []
        for raw in m.get(13, []):
            p = pb_fields(raw)
            info = pb_fields(_one(p, 7, b""))
            ops = []
            for rop in p.get(8, []):
                o = pb_fields(rop)
                ops.append({
                    "type": _one(o, 1, 0),
                    "off": _one(o, 2, 0),
                    "len": _one(o, 3, 0),
                    "src": bool(o.get(4)),
                    "dst": [(_one(e, 1, 0), _one(e, 2, 0)) for e in map(pb_fields, o.get(6, []))],
                    "sha": _one(o, 8),
                })
            self.partitions.append({
                "name": _one(p, 1, b"").decode(),
                "size": _one(info, 1, 0),
                "hash": _one(info, 2),
                "ops": ops,
            })

    def is_delta(self, part):
        return any(o["type"] not in FULL_OPS or o["src"] for o in part["ops"])

    def describe(self):
        log("payload.bin  block size %d, %s, %d partitions" % (
            self.block_size, "full OTA" if self.minor_version == 0 else
            "incremental OTA (minor %d)" % self.minor_version, len(self.partitions)))
        for p in self.partitions:
            kinds = sorted({OP_NAMES.get(o["type"], str(o["type"])) for o in p["ops"]})
            log("  %-24s %10s  %s" % (p["name"], human(p["size"]), ",".join(kinds)))

    def extract(self, part, out_path, verify=False):
        if self.is_delta(part):
            raise FwError("%s is an incremental (delta) update and needs the old "
                          "partition to patch against; use a full OTA instead" % part["name"])
        bs = self.block_size
        tmp = out_path + ".part"
        prog = Progress(part["name"] + ".img", part["size"])
        with removed_on_error(tmp), open(self.path, "rb") as f, open(tmp, "wb") as out:
            out.truncate(part["size"])
            for op in part["ops"]:
                t = op["type"]
                if t in (OP_ZERO, OP_DISCARD):  # truncate() already zero-filled
                    prog.add(sum(n for _, n in op["dst"]) * bs)
                    continue
                writer = _ExtentWriter(out, op["dst"], bs)
                d = (_Identity() if t == OP_REPLACE else
                     _StdlibWrap(bz2.BZ2Decompressor()) if t == OP_BZ else
                     _StdlibWrap(lzma.LZMADecompressor()) if t == OP_XZ else
                     zstd_decompressor())
                h = hashlib.sha256() if op["sha"] else None
                f.seek(self.data_offset + op["off"])
                left = op["len"]
                while left > 0:
                    chunk = f.read(min(BUF, left))
                    if not chunk:
                        raise FwError("%s: payload is truncated (did the download finish?)" % part["name"])
                    left -= len(chunk)
                    if h:
                        h.update(chunk)
                    writer.write(d.decompress(chunk))
                writer.write(d.flush())
                if h and h.digest() != op["sha"]:
                    raise FwError("checksum mismatch in %s: the payload is corrupt" % part["name"])
                prog.add(writer.written)
        note = "ok"
        if verify and part["hash"]:
            if sha256_file(tmp) != part["hash"]:
                os.remove(tmp)
                raise FwError("%s: final image hash does not match the manifest" % part["name"])
            note = "ok, sha256 verified"
        os.replace(tmp, out_path)
        prog.finish(note)


class _ExtentWriter:
    def __init__(self, f, extents, bs):
        self.f = f
        self.ext = [(s * bs, n * bs) for s, n in extents]
        self.idx = 0
        self.pos = 0  # offset inside current extent
        self.written = 0

    def write(self, data):
        mv = memoryview(data)
        while len(mv):
            if self.idx >= len(self.ext):
                raise FwError("operation produced more data than its extents hold")
            start, length = self.ext[self.idx]
            n = min(length - self.pos, len(mv))
            self.f.seek(start + self.pos)
            self.f.write(mv[:n])
            mv = mv[n:]
            self.pos += n
            self.written += n
            if self.pos == length:
                self.idx += 1
                self.pos = 0


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(BUF), b""):
            h.update(chunk)
    return h.digest()


# --------------------------------------------------------------------------
# Android sparse images
# --------------------------------------------------------------------------

SPARSE_MAGIC = 0xED26FF3A


def sparse_info(path):
    with open(path, "rb") as f:
        h = f.read(28)
    magic, major, _minor, _fh, _ch, blk, total_blks, chunks, _ = struct.unpack("<IHHHHIIII", h)
    return blk, total_blks, chunks


def unsparse(inputs, out_path, label):
    """Merge one or more sparse files (e.g. sparsechunk sets) into a raw image."""
    total = sum(os.path.getsize(p) for p in inputs)
    prog = Progress(label, total)
    size = 0
    tmp = out_path + ".part"
    with removed_on_error(tmp), open(tmp, "wb") as out:
        for p in inputs:
            with open(p, "rb") as f:
                h = f.read(28)
                magic, major, _mn, fhs, chs, blk, tblks, nchunks, _ = struct.unpack("<IHHHHIIII", h)
                if magic != SPARSE_MAGIC or major != 1:
                    raise FwError("%s is not a sparse image" % p)
                f.seek(fhs)
                pos = 0
                for _ in range(nchunks):
                    ch = f.read(chs)
                    ctype, _r, csz, tsz = struct.unpack("<HHII", ch[:12])
                    dlen = tsz - chs
                    if ctype == 0xCAC1:  # raw
                        copy_range(f, f.tell(), out, pos * blk, dlen, prog)
                    elif ctype == 0xCAC2:  # fill
                        fill = f.read(4)
                        if fill != b"\0\0\0\0":
                            out.seek(pos * blk)
                            block = fill * (blk // 4)
                            per = max(1, BUF // blk)
                            left = csz
                            while left:
                                k = min(per, left)
                                out.write(block * k)
                                left -= k
                        prog.add(dlen)
                    elif ctype == 0xCAC3:  # don't care
                        pass
                    elif ctype == 0xCAC4:  # crc32
                        f.read(4)
                    else:
                        raise FwError("bad sparse chunk type 0x%x in %s" % (ctype, p))
                    pos += csz
                size = max(size, tblks * blk)
        out.truncate(size)
    os.replace(tmp, out_path)
    prog.done = prog.total
    prog.total = size
    prog.finish("unsparsed")


# --------------------------------------------------------------------------
# super.img (dynamic partitions, LP metadata)
# --------------------------------------------------------------------------

LP_GEOMETRY_MAGIC = 0x616C4467
LP_HEADER_MAGIC = 0x414C5030
LP_RESERVED = 4096
LP_GEOMETRY_SIZE = 4096


def read_super(path):
    with open(path, "rb") as f:
        f.seek(LP_RESERVED)
        g = f.read(52)
        magic, _ssize, _ck, _max, _slots, _lbs = struct.unpack("<II32sIII", g)
        if magic != LP_GEOMETRY_MAGIC:
            raise FwError("no LP metadata found (not a super image)")
        hoff = LP_RESERVED + 2 * LP_GEOMETRY_SIZE
        f.seek(hoff)
        hdr = f.read(256)
        (hmagic, major, minor, hsize, _hck, tsize, _tck) = struct.unpack_from("<IHHI32sI32s", hdr, 0)
        if hmagic != LP_HEADER_MAGIC:
            raise FwError("corrupt LP metadata header")
        descs = [struct.unpack_from("<III", hdr, 80 + 12 * i) for i in range(4)]
        f.seek(hoff + hsize)
        tables = f.read(tsize)

    def table(i):
        off, num, esz = descs[i]
        return [tables[off + k * esz: off + (k + 1) * esz] for k in range(num)]

    extents = [struct.unpack_from("<QIQI", e) for e in table(1)]
    parts = []
    for e in table(0):
        name, attrs, first, num, group = struct.unpack_from("<36sIIII", e)
        exts = extents[first:first + num]
        parts.append({
            "name": name.rstrip(b"\0").decode(),
            "extents": exts,
            "size": sum(x[0] for x in exts) * 512,
        })
    return {"version": "%d.%d" % (major, minor), "partitions": parts}


def extract_super_partition(path, part, out_path):
    prog = Progress(part["name"] + ".img", part["size"])
    tmp = out_path + ".part"
    with removed_on_error(tmp), open(path, "rb") as f, open(tmp, "wb") as out:
        out.truncate(part["size"])
        pos = 0
        for sectors, ttype, tdata, tsrc in part["extents"]:
            n = sectors * 512
            if ttype == 0:  # linear
                if tsrc != 0:
                    raise FwError("%s lives on a second block device (retrofit "
                                  "device); only the super image itself is supported" % part["name"])
                copy_range(f, tdata * 512, out, pos, n, prog)
            else:  # zero
                prog.add(n)
            pos += n
    os.replace(tmp, out_path)
    prog.finish("ok")


# --------------------------------------------------------------------------
# boot.img / init_boot.img / vendor_boot.img
# --------------------------------------------------------------------------

def _pad(n, page):
    return (n + page - 1) // page * page


def _os_version(v):
    if not v:
        return "unset"
    ver, lvl = v >> 11, v & 0x7FF
    return "Android %d.%d.%d, patch %04d-%02d" % (
        (ver >> 14) & 0x7F, (ver >> 7) & 0x7F, ver & 0x7F, 2000 + (lvl >> 4), lvl & 0xF)


def parse_boot(path):
    """Return (info dict, [(name, offset, size), ...]) for a boot-type image."""
    with open(path, "rb") as f:
        h = f.read(4096)
    sections = []
    info = {}
    if h[:8] == b"VNDRBOOT":
        (_, hv, page, _ka, _ra, vrsize, cmdline, _ta, name, hsize, dtbsize, _da) = \
            struct.unpack_from("<8sIIIII2048sI16sIIQ", h)
        info.update(type="vendor_boot", header_version=hv, page_size=page,
                    name=name.rstrip(b"\0").decode(errors="replace"),
                    cmdline=cmdline.rstrip(b"\0").decode(errors="replace"))
        off = _pad(hsize, page)
        sections.append(("vendor_ramdisk", off, vrsize))
        off += _pad(vrsize, page)
        sections.append(("dtb", off, dtbsize))
        off += _pad(dtbsize, page)
        if hv >= 4:
            tsize, tnum, tesz, bcsize = struct.unpack_from("<IIII", h, 2112)
            with open(path, "rb") as f:
                f.seek(off)
                table = f.read(tsize)
            vr_off = sections[0][1]
            for i in range(tnum):
                rsize, roff, _rtype, rname = struct.unpack_from("<III32s", table, i * tesz)
                rname = rname.rstrip(b"\0").decode(errors="replace") or "ramdisk%d" % i
                sections.append(("vendor_ramdisk_" + rname, vr_off + roff, rsize))
            off += _pad(tsize, page)
            sections.append(("bootconfig", off, bcsize))
        return info, sections
    if h[:8] != b"ANDROID!":
        raise FwError("not a boot image")
    hv = struct.unpack_from("<I", h, 40)[0]
    if hv in (3, 4):
        ksize, rsize, osv, _hs = struct.unpack_from("<IIII", h, 8)
        cmdline = struct.unpack_from("<1536s", h, 44)[0]
        info.update(type="boot", header_version=hv, page_size=4096,
                    os_version=_os_version(osv),
                    cmdline=cmdline.rstrip(b"\0").decode(errors="replace"))
        off = 4096
        sections.append(("kernel", off, ksize))
        off += _pad(ksize, 4096)
        sections.append(("ramdisk", off, rsize))
        off += _pad(rsize, 4096)
        if hv == 4:
            sections.append(("boot_signature", off, struct.unpack_from("<I", h, 1580)[0]))
        return info, sections
    (ksize, _ka, rsize, _ra, ssize, _sa, _ta, page, hv, osv) = struct.unpack_from("<10I", h, 8)
    name, cmdline, _id, extra = struct.unpack_from("<16s512s32s1024s", h, 48)
    dt_size = 0
    if hv > 4:  # very old Qualcomm images reuse this field as dt_size
        dt_size, hv = hv, 0
    info.update(type="boot", header_version=hv, page_size=page,
                os_version=_os_version(osv), name=name.rstrip(b"\0").decode(errors="replace"),
                cmdline=(cmdline.rstrip(b"\0") + extra.rstrip(b"\0")).decode(errors="replace"))
    off = page
    for sname, size in (("kernel", ksize), ("ramdisk", rsize), ("second", ssize)):
        sections.append((sname, off, size))
        off += _pad(size, page)
    if dt_size:
        sections.append(("dt", off, dt_size))
    if hv >= 1:
        rdsize = struct.unpack_from("<I", h, 1632)[0]
        sections.append(("recovery_dtbo", off, rdsize))
        off += _pad(rdsize, page)
    if hv >= 2:
        dtbsize = struct.unpack_from("<I", h, 1648)[0]
        sections.append(("dtb", off, dtbsize))
    return info, sections


def unpack_boot(path, outdir):
    info, sections = parse_boot(path)
    os.makedirs(outdir, exist_ok=True)
    lines = ["%s: %s" % (k, v) for k, v in info.items()]
    with open(path, "rb") as f:
        for name, off, size in sections:
            if not size:
                continue
            f.seek(off)
            data = f.read(size)
            with open(os.path.join(outdir, name), "wb") as o:
                o.write(data)
            lines.append("%s: %d bytes at 0x%x" % (name, size, off))
            # The whole vendor ramdisk is the concatenation of the named ones
            # in v4; unpack those individually instead.
            if "ramdisk" in name and not (name == "vendor_ramdisk" and any(
                    s[0].startswith("vendor_ramdisk_") for s in sections)):
                try:
                    cpio, fmt = decompress_bytes(data)
                    lines.append("%s compression: %s" % (name, fmt))
                    if cpio[:6] in (b"070701", b"070702"):
                        n = cpio_extract(cpio, os.path.join(outdir, name + "_files"))
                        lines.append("%s files: %d" % (name, n))
                except Exception as e:  # keep the raw section even if unpacking fails
                    warn("could not unpack %s: %s" % (name, e))
    with open(os.path.join(outdir, "bootimg.txt"), "w") as o:
        o.write("\n".join(lines) + "\n")
    log("  %-28s %10s  unpacked to %s/" % (os.path.basename(path), "", os.path.basename(outdir)))


def cpio_extract(data, outdir):
    """Unpack a newc cpio archive. Returns the number of entries written."""
    os.makedirs(outdir, exist_ok=True)
    i, count, links = 0, 0, []
    while i + 110 <= len(data):
        hdr = data[i:i + 110]
        if hdr[:6] not in (b"070701", b"070702"):
            if hdr[:6] == b"\0" * 6:  # concatenated archives padded with zeros
                i += 4
                continue
            break
        f = [int(hdr[6 + 8 * k: 14 + 8 * k], 16) for k in range(13)]
        mode, fsize, nsize = f[1], f[6], f[11]
        name = data[i + 110: i + 110 + nsize - 1].decode(errors="replace")
        i = _pad(i + 110 + nsize, 4)
        body = data[i:i + fsize]
        i = _pad(i + fsize, 4)
        if name == "TRAILER!!!":
            continue  # ramdisks are sometimes several archives back to back
        dest = safe_join(outdir, name)
        if dest is None:
            continue
        kind = mode & 0o170000
        try:
            if kind == 0o040000:
                os.makedirs(dest, exist_ok=True)
            elif kind == 0o120000:
                links.append((dest, body.decode(errors="replace")))
            elif kind == 0o100000:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as o:
                    o.write(body)
                try:
                    os.chmod(dest, mode & 0o777 | 0o200)
                except OSError:
                    pass
            else:
                continue  # device nodes, fifos: not creatable without root
            count += 1
        except OSError as e:
            warn("skipping %s: %s" % (name, e))
    for dest, target in links:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            if os.path.lexists(dest):
                os.remove(dest)
            os.symlink(target, dest)
        except OSError:
            # Shared storage (/sdcard) cannot hold symlinks; record them instead.
            with open(dest + ".symlink", "w") as o:
                o.write(target + "\n")
        count += 1
    return count


# --------------------------------------------------------------------------
# Block-based OTA: transfer.list + new.dat(.br)
# --------------------------------------------------------------------------

def _rangeset(s):
    nums = [int(x) for x in s.split(",")]
    return list(zip(nums[1::2], nums[2::2]))


def sdat2img(transfer_list, new_dat, out_path, label):
    with open(transfer_list) as f:
        lines = f.read().splitlines()
    version, total_blocks = int(lines[0]), int(lines[1])
    cmds = lines[2:] if version == 1 else lines[4:]
    bs = 4096
    prog = Progress(label, total_blocks * bs)
    tmp = out_path + ".part"
    with removed_on_error(tmp), open(new_dat, "rb") as src, open(tmp, "wb") as out:
        out.truncate(total_blocks * bs)
        for line in cmds:
            parts = line.split()
            if not parts:
                continue
            cmd = parts[0]
            if cmd == "new":
                for a, b in _rangeset(parts[1]):
                    copy_range(src, src.tell(), out, a * bs, (b - a) * bs, prog)
            elif cmd in ("erase", "zero"):
                continue
            elif cmd in ("move", "bsdiff", "imgdiff", "stash", "free"):
                raise FwError("%s is an incremental block OTA (needs the old image)" % transfer_list)
    os.replace(tmp, out_path)
    prog.done = prog.total
    prog.finish("ok")


# --------------------------------------------------------------------------
# Filesystem images (optional, external tools)
# --------------------------------------------------------------------------

def unpack_fs(path, kind, outdir):
    if kind == "ext4":
        if not have("debugfs"):
            warn("skipping %s: needs debugfs: %s" % (path, install_hint("debugfs")))
            return False
        os.makedirs(outdir, exist_ok=True)
        argv = ["debugfs", "-R", "rdump / %s" % outdir, path]
    else:
        tool = "fsck.erofs" if have("fsck.erofs") else None
        if not tool:
            warn("skipping %s: needs fsck.erofs: %s" % (path, install_hint("fsck.erofs")))
            return False
        argv = [tool, "--extract=%s" % outdir, path]
    r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode != 0:
        warn("%s exited %d: %s" % (argv[0], r.returncode, r.stderr.decode(errors="replace").strip()[-300:]))
        return False
    log("  %-28s %10s  files in %s/" % (os.path.basename(path), kind, os.path.basename(outdir)))
    return True


# --------------------------------------------------------------------------
# Detection
# --------------------------------------------------------------------------

def detect(path):
    name = os.path.basename(path).lower()
    if name.endswith(".transfer.list"):
        return "sdat"
    if name.endswith((".new.dat", ".new.dat.br", ".patch.dat")):
        return "sdat-data"
    with open(path, "rb") as f:
        h = f.read(4200)
    if h[:4] == b"PK\x03\x04" or (name.endswith(".zip") and zipfile.is_zipfile(path)):
        return "zip"
    if h[:4] == b"CrAU":
        return "payload"
    if len(h) >= 4 and struct.unpack("<I", h[:4])[0] == SPARSE_MAGIC:
        return "sparse"
    if h[:8] in (b"ANDROID!", b"VNDRBOOT"):
        return "boot"
    if len(h) >= 4 and struct.unpack("<I", h[:4])[0] in (LZ4_FRAME_MAGIC, LZ4_LEGACY_MAGIC):
        return "lz4"
    if h[:4] == b"\x28\xb5\x2f\xfd":
        return "zstd"
    if h[257:262] == b"ustar":
        return "tar"
    if h[:2] == b"\x1f\x8b" or h[:6] == b"\xfd7zXZ\x00" or h[:3] == b"BZh":
        if tarfile.is_tarfile(path):
            return "tar"
        return {b"\x1f": "gzip", b"\xfd": "xz", b"B": "bzip2"}[h[:1]]
    if name.endswith(".br"):
        return "brotli"
    if len(h) >= 4100 and struct.unpack_from("<I", h, 4096)[0] == LP_GEOMETRY_MAGIC:
        return "super"
    if len(h) >= 1084 and h[1080:1082] == b"\x53\xef":
        return "ext4"
    if len(h) >= 1028 and h[1024:1028] == b"\xe2\xe1\xf5\xe0":
        return "erofs"
    return "other"


_STRIP = (".lz4", ".zst", ".gz", ".xz", ".bz2", ".br", ".img", ".bin", ".ext4",
          ".new.dat", ".transfer.list", ".patch.dat", ".raw", ".sparse", ".md5", ".tar")


def base_name(path):
    n = os.path.basename(path).lower()
    n = re.sub(r"_sparsechunk\.\d+$", "", n)
    changed = True
    while changed:
        changed = False
        for s in _STRIP:
            if n.endswith(s) and len(n) > len(s):
                n = n[: -len(s)]
                changed = True
    return n


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

class Extractor:
    def __init__(self, opts):
        self.o = opts
        self.want = None
        if opts.partitions:
            self.want = {p.strip().lower() for p in opts.partitions.split(",") if p.strip()}
        self.failures = 0

    # A partition filter like "-p boot,system" should still let containers
    # through (super, nested zips, tars) because the wanted images live inside.
    def wanted(self, name, container_ok=True):
        if self.want is None:
            return True
        b = base_name(name)
        if container_ok and (b in ("super", "payload") or b.startswith("image-") or
                             re.search(r"\.(zip|tar|md5|tgz)$", name.lower()) or
                             re.match(r"^(ap|csc|home_csc|bl|cp)_", b)):
            return True
        return b in self.want or re.sub(r"_[ab]$", "", b) in self.want

    def run(self, path):
        if not os.path.isdir(path):
            kind = detect(path)
            if kind in ("other", "sdat-data"):
                raise FwError("%s is not a firmware format this tool recognises "
                              "(try --list to see what it detects)" % os.path.basename(path))
            if kind == "boot" and not self.o.unpack_boot:
                log("%s is a boot image; add --unpack-boot to split it" % os.path.basename(path))
                return
            if kind in ("ext4", "erofs") and not self.o.unpack_fs:
                log("%s is an %s filesystem image; add --unpack-fs to copy its files out"
                    % (os.path.basename(path), kind))
                return
        os.makedirs(self.o.outdir, exist_ok=True)
        if os.path.isdir(path):
            self.handle_dir(path, self.o.outdir, produced=False)
        else:
            self.handle(path, self.o.outdir, produced=False)
        if self.want:
            found = set()
            for _root, _dirs, names in os.walk(self.o.outdir):
                for n in names:
                    b = base_name(n)
                    found.update((b, re.sub(r"_[ab]$", "", b)))
            missing = sorted(self.want - found)
            if missing:
                self.failures += 1
                warn("not found: %s (use --list to see what is inside)" % ", ".join(missing))

    def _dest(self, src, outdir, produced, new_name):
        d = os.path.dirname(src) if produced else outdir
        dst = os.path.join(d, new_name)
        if os.path.exists(dst) and os.path.samefile(dst, src):
            stem, ext = os.path.splitext(new_name)
            dst = os.path.join(d, stem + ".raw" + (ext or ".img"))
        return dst

    def _done_with(self, path, produced):
        if produced and not self.o.keep and os.path.exists(path):
            os.remove(path)

    def handle(self, path, outdir, produced, depth=0):
        if depth > 8:
            warn("nesting too deep at %s" % path)
            return
        try:
            kind = detect(path)
            fn = getattr(self, "do_" + kind.replace("-", "_"), None)
            if fn:
                fn(path, outdir, produced, depth)
        except FwError as e:
            self.failures += 1
            warn("%s: %s" % (os.path.basename(path), e))
        except zipfile.BadZipFile as e:
            self.failures += 1
            warn("%s: the zip is damaged or incomplete (did the download finish?): %s"
                 % (os.path.basename(path), e))
        except MemoryError:
            self.failures += 1
            warn("%s: ran out of memory; the file is probably corrupt" % os.path.basename(path))
        except (OSError, EOFError, tarfile.TarError,
                lzma.LZMAError, zlib.error, struct.error, IndexError, ValueError) as e:
            self.failures += 1
            warn("%s: %s: %s" % (os.path.basename(path), type(e).__name__, e))

    def handle_dir(self, d, outdir, produced, depth=0):
        files = []
        for root, _dirs, names in os.walk(d):
            files.extend(os.path.join(root, n) for n in sorted(names))
        self.handle_files(files, outdir, produced, depth)

    def handle_files(self, files, outdir, produced, depth=0):
        """Handle sibling files, merging *_sparsechunk.N sets first."""
        chunks, rest = {}, []
        for p in files:
            m = re.match(r"(.+)_sparsechunk\.(\d+)$", p)
            if m:
                chunks.setdefault(m.group(1), []).append((int(m.group(2)), p))
            else:
                rest.append(p)
        for target, items in sorted(chunks.items()):
            if not self.wanted(target):
                continue
            inputs = [p for _, p in sorted(items)]
            dst = target if produced else os.path.join(outdir, os.path.basename(target))
            try:
                unsparse(inputs, dst, os.path.basename(dst))
                for p in inputs:
                    self._done_with(p, produced)
                self.handle(dst, outdir, True, depth + 1)
            except (FwError, OSError, struct.error) as e:
                self.failures += 1
                warn("%s: %s" % (os.path.basename(target), e))
        for p in rest:
            if os.path.exists(p) and self.wanted(p):
                self.handle(p, outdir, produced, depth + 1)

    # ---- handlers -------------------------------------------------------

    def do_zip(self, path, outdir, produced, depth):
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            payload = next((i for i in infos if os.path.basename(i.filename) == "payload.bin"), None)
            if payload is not None:
                log("%s: A/B OTA package" % os.path.basename(path))
                if payload.compress_type == zipfile.ZIP_STORED and not payload.flag_bits & 1:
                    with open(path, "rb") as f:
                        f.seek(payload.header_offset)
                        lh = f.read(30)
                        nlen, elen = struct.unpack("<HH", lh[26:30])
                    base = payload.header_offset + 30 + nlen + elen
                    dest = os.path.dirname(path) if produced else outdir
                    self.payload(Payload(path, base, "payload.bin"), dest, depth)
                else:
                    dest = os.path.dirname(path) if produced else outdir
                    tmp = zf.extract(payload, dest)
                    self.handle(tmp, os.path.dirname(tmp), True, depth + 1)
                    self._done_with(tmp, True)
                self._done_with(path, produced)
                return
            log("%s: zip archive, %d entries" % (os.path.basename(path), len(infos)))
            if produced:  # nested zip (e.g. Pixel image-*.zip): unpack beside it
                dest = os.path.join(os.path.dirname(path),
                                    re.sub(r"\.zip$", "", os.path.basename(path), flags=re.I))
            else:
                dest = outdir
            os.makedirs(dest, exist_ok=True)
            members = [i for i in infos if not i.is_dir() and self.wanted(i.filename)
                       and safe_join(dest, i.filename) is not None]
            check_space(dest, sum(i.file_size for i in members))
            written = []
            for i in members:
                prog = Progress(os.path.basename(i.filename), i.file_size)
                written.append(zf.extract(i, dest))
                prog.done = prog.total
                prog.finish("extracted")
        self._done_with(path, produced)
        self.handle_files(written, dest, True, depth)

    def payload(self, pl, outdir, depth):
        parts = [p for p in pl.partitions if self.wanted(p["name"], container_ok=False)]
        if self.want and not parts:
            raise FwError("none of %s are in this payload (it has: %s)" % (
                ",".join(sorted(self.want)), ", ".join(p["name"] for p in pl.partitions)))
        check_space(outdir, sum(p["size"] for p in parts))
        outs = []
        for p in parts:
            out = os.path.join(outdir, p["name"] + ".img")
            try:
                pl.extract(p, out, self.o.verify)
                outs.append(out)
            except FwError as e:
                self.failures += 1
                warn(str(e))
        for out in outs:
            self.handle(out, outdir, True, depth + 1)

    def do_payload(self, path, outdir, produced, depth):
        log("%s: A/B OTA payload" % os.path.basename(path))
        dest = os.path.dirname(path) if produced else outdir
        self.payload(Payload(path), dest, depth)
        self._done_with(path, produced)

    def do_sparse(self, path, outdir, produced, depth):
        name = os.path.basename(path)
        # system.simg / system_sparse.img / system.img.sparse -> system.img
        name = re.sub(r"(\.simg|[._]sparse\.img|\.img\.sparse)$", ".img", name, flags=re.I)
        if produced:
            dst = os.path.join(os.path.dirname(path), name)
            tmp = dst + ".raw"
            unsparse([path], tmp, name)
            os.replace(tmp, dst)
            if dst != path:
                os.remove(path)
        else:
            dst = self._dest(path, outdir, produced, name)
            unsparse([path], dst, name)
        self.handle(dst, outdir, True, depth + 1)

    def do_super(self, path, outdir, produced, depth):
        sup = read_super(path)
        dest = os.path.dirname(path) if produced else outdir
        log("%s: super image (LP metadata %s)" % (os.path.basename(path), sup["version"]))
        parts = [p for p in sup["partitions"]
                 if p["size"] and self.wanted(p["name"], container_ok=False)]
        check_space(dest, sum(p["size"] for p in parts))
        outs, failed = [], False
        for p in parts:
            out = os.path.join(dest, p["name"] + ".img")
            if os.path.exists(out) and os.path.samefile(out, path):
                out = os.path.join(dest, p["name"] + ".lp.img")
            try:
                extract_super_partition(path, p, out)
                outs.append(out)
            except FwError as e:
                self.failures += 1
                failed = True
                warn(str(e))
        if not failed:
            self._done_with(path, produced)
        for out in outs:
            self.handle(out, outdir, True, depth + 1)

    def do_boot(self, path, outdir, produced, depth):
        if not self.o.unpack_boot:
            return
        d = os.path.dirname(path) if produced else outdir
        unpack_boot(path, os.path.join(d, base_name(path) + "_unpacked"))

    def _decompress_then(self, kind, path, outdir, produced, depth):
        name = os.path.basename(path)
        for ext in (".lz4", ".zst", ".gz", ".xz", ".bz2", ".br"):
            if name.lower().endswith(ext):
                name = name[: -len(ext)]
                break
        else:
            name += ".out"
        dst = self._dest(path, outdir, produced, name)
        decompress_file(kind, path, dst, name)
        self._done_with(path, produced)
        self.handle(dst, outdir, True, depth + 1)

    def do_lz4(self, *a):
        self._decompress_then("lz4", *a)

    def do_zstd(self, *a):
        self._decompress_then("zstd", *a)

    def do_gzip(self, *a):
        self._decompress_then("gzip", *a)

    def do_xz(self, *a):
        self._decompress_then("xz", *a)

    def do_bzip2(self, *a):
        self._decompress_then("bzip2", *a)

    def do_brotli(self, *a):
        self._decompress_then("brotli", *a)

    def do_tar(self, path, outdir, produced, depth):
        dest = os.path.dirname(path) if produced else outdir
        log("%s: tar archive" % os.path.basename(path))
        written = []
        with tarfile.open(path, "r:*") as tf:
            for m in tf:
                if not m.isfile() or not self.wanted(m.name):
                    continue
                out = safe_join(dest, m.name)
                if out is None:
                    continue
                os.makedirs(os.path.dirname(out), exist_ok=True)
                prog = Progress(os.path.basename(m.name), m.size)
                src = tf.extractfile(m)
                with removed_on_error(out), open(out, "wb") as o:
                    for chunk in iter(lambda: src.read(BUF), b""):
                        o.write(chunk)
                        prog.add(len(chunk))
                prog.finish("extracted")
                written.append(out)
        self._done_with(path, produced)
        self.handle_files(written, dest, True, depth)

    def do_sdat(self, path, outdir, produced, depth):
        stem = path[: -len(".transfer.list")]
        name = os.path.basename(stem) + ".img"
        if not self.wanted(name, container_ok=False):
            return
        data, tmp = stem + ".new.dat", None
        if not os.path.exists(data):
            br = stem + ".new.dat.br"
            if not os.path.exists(br):
                raise FwError("no %s.new.dat(.br) next to the transfer list" % os.path.basename(stem))
            tmp = os.path.join(os.path.dirname(path) if produced else outdir,
                               os.path.basename(stem) + ".new.dat.tmp")
            decompress_file("brotli", br, tmp, os.path.basename(br))
            data = tmp
        dst = self._dest(path, outdir, produced, name)
        sdat2img(path, data, dst, name)
        if tmp:
            os.remove(tmp)
        if produced and not self.o.keep:
            for p in (path, stem + ".new.dat", stem + ".new.dat.br", stem + ".patch.dat"):
                if os.path.exists(p):
                    os.remove(p)
        self.handle(dst, outdir, True, depth + 1)

    def do_ext4(self, path, outdir, produced, depth):
        if self.o.unpack_fs:
            d = os.path.dirname(path) if produced else outdir
            unpack_fs(path, "ext4", os.path.join(d, base_name(path) + "_files"))

    def do_erofs(self, path, outdir, produced, depth):
        if self.o.unpack_fs:
            d = os.path.dirname(path) if produced else outdir
            unpack_fs(path, "erofs", os.path.join(d, base_name(path) + "_files"))


# --------------------------------------------------------------------------
# --list: describe without writing anything
# --------------------------------------------------------------------------

def describe(path):
    kind = detect(path)
    name = os.path.basename(path)
    if kind == "zip":
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            payload = next((i for i in infos if os.path.basename(i.filename) == "payload.bin"), None)
            if payload is not None and payload.compress_type == zipfile.ZIP_STORED:
                with open(path, "rb") as f:
                    f.seek(payload.header_offset)
                    lh = f.read(30)
                nlen, elen = struct.unpack("<HH", lh[26:30])
                log("%s: A/B OTA zip" % name)
                Payload(path, payload.header_offset + 30 + nlen + elen).describe()
                return
            log("%s: zip, %d entries" % (name, len(infos)))
            for i in infos:
                if not i.is_dir():
                    log("  %-48s %10s" % (i.filename, human(i.file_size)))
    elif kind == "payload":
        Payload(path).describe()
    elif kind == "sparse":
        blk, tb, ch = sparse_info(path)
        log("%s: Android sparse image, %s when unsparsed (%d chunks)" % (name, human(blk * tb), ch))
    elif kind == "super":
        s = read_super(path)
        log("%s: super image, LP metadata %s" % (name, s["version"]))
        for p in s["partitions"]:
            log("  %-24s %10s%s" % (p["name"], human(p["size"]), "" if p["size"] else "  (empty)"))
    elif kind == "boot":
        info, sections = parse_boot(path)
        log("%s: %s image, header v%s" % (name, info["type"], info["header_version"]))
        for k in ("os_version", "name", "cmdline"):
            if info.get(k):
                log("  %-14s %s" % (k, info[k]))
        for s, off, size in sections:
            if size:
                log("  %-28s %10s  @0x%x" % (s, human(size), off))
    elif kind == "tar":
        log("%s: tar archive" % name)
        with tarfile.open(path, "r:*") as tf:
            for m in tf:
                if m.isfile():
                    log("  %-48s %10s" % (m.name, human(m.size)))
    else:
        log("%s: %s (%s)" % (name, kind, human(os.path.getsize(path))))


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def check_tools():
    """Report which optional helpers are available. Returns 0 if all are."""
    rows = [
        ("lz4", "fast Samsung .lz4 images (a slower built-in decoder is used otherwise)"),
        ("zstd", "REPLACE_ZSTD OTAs and .zst images"),
        ("brotli", "block-based ROMs with *.new.dat.br"),
        ("debugfs", "--unpack-fs on ext4 images"),
        ("fsck.erofs", "--unpack-fs on erofs images"),
    ]
    log("python      %s  (%s)" % ("ok", sys.version.split()[0]))
    missing = 0
    for tool, use in rows:
        path = shutil.which(tool)
        if not path and tool == "zstd" and sys.version_info >= (3, 14):
            path = "built into Python 3.14"
        log("%-11s %s  %s" % (tool, "ok" if path else "--", use))
        if not path:
            missing += 1
            log("            install: " + install_hint(tool))
    return 0 if not missing else 3


def main(argv=None):
    global QUIET
    ap = argparse.ArgumentParser(
        prog="fwextract",
        description="Extract Android firmware (OTA zips, payload.bin, super/sparse/boot "
                    "images, Samsung tar.md5) on the phone itself.",
        epilog="examples:\n"
               "  fwextract ota.zip -p boot,init_boot      # just the images Magisk/KernelSU need\n"
               "  fwextract ota.zip --list                  # what is inside, nothing written\n"
               "  fwextract AP_XXX.tar.md5 -p boot,vbmeta   # Samsung firmware\n"
               "  fwextract super.img -o parts              # split dynamic partitions\n"
               "  fwextract boot.img --unpack-boot          # kernel, ramdisk files, cmdline\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?", help="firmware file or an already-unpacked directory")
    ap.add_argument("-o", "--outdir", help="output directory (default: <input>_extracted)")
    ap.add_argument("-p", "--partitions", help="comma-separated partitions to extract, e.g. boot,init_boot")
    ap.add_argument("-l", "--list", action="store_true", help="show what is inside and exit")
    ap.add_argument("--unpack-boot", action="store_true",
                    help="also split boot images into kernel, ramdisk files, dtb, cmdline")
    ap.add_argument("--unpack-fs", action="store_true",
                    help="also copy files out of ext4/erofs images (needs debugfs / fsck.erofs)")
    ap.add_argument("--verify", action="store_true",
                    help="re-hash every extracted payload partition against the manifest")
    ap.add_argument("--keep", action="store_true",
                    help="keep intermediate files (e.g. super.img after splitting it)")
    ap.add_argument("-q", "--quiet", action="store_true", help="only print warnings and errors")
    ap.add_argument("--check", action="store_true",
                    help="show which optional helper tools are installed and exit")
    ap.add_argument("--version", action="version", version="%(prog)s " + __version__)
    o = ap.parse_args(argv)
    QUIET = o.quiet

    if o.check:
        return check_tools()
    if not o.input:
        ap.error("the input file is required (or use --check)")
    if not os.path.exists(o.input):
        print("error: %s does not exist" % o.input, file=sys.stderr)
        return 1
    try:
        if o.list:
            if os.path.isdir(o.input):
                for root, _d, names in os.walk(o.input):
                    for n in sorted(names):
                        describe(os.path.join(root, n))
            else:
                describe(o.input)
            return 0
        if not o.outdir:
            o.outdir = os.path.basename(os.path.normpath(o.input))
            stem = o.outdir
            while True:
                shorter = re.sub(r"\.(zip|bin|img|tar|md5|lz4|tgz|gz|xz|zst)$", "", stem, flags=re.I)
                if shorter == stem or not shorter:
                    break
                stem = shorter
            o.outdir = stem + "_extracted"
        ex = Extractor(o)
        ex.run(o.input)
    except FwError as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
    log("done -> %s" % os.path.abspath(o.outdir))
    if ex.failures:
        warn("%d item(s) failed, see warnings above" % ex.failures)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
