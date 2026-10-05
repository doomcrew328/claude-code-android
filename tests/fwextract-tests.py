#!/usr/bin/env python3
"""Tests for tools/fwextract.py.

Builds small synthetic firmware files in every supported format, runs the
extractor on them, and checks the output byte for byte. Needs only the
Python standard library; cases that need lz4/zstd/brotli (Python modules,
used only to *build* fixtures) or debugfs are skipped when those are absent.

Usage:
  python3 tests/fwextract-tests.py -v
"""

import bz2
import gzip
import hashlib
import io
import lzma
import os
import random
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import fwextract  # noqa: E402

fwextract.QUIET = True


def optional(mod):
    try:
        return __import__(mod)
    except ImportError:
        return None


lz4 = optional("lz4.frame") and __import__("lz4.block") and sys.modules["lz4"]
zstandard = optional("zstandard")
brotli = optional("brotli")

BS = 4096


def blob(n, seed):
    r = random.Random(seed)
    # Compressible but not trivial: random words repeated.
    words = [bytes(r.getrandbits(8) for _ in range(r.randint(3, 12))) for _ in range(64)]
    out = bytearray()
    while len(out) < n:
        out += r.choice(words)
    return bytes(out[:n])


def run(*args):
    return fwextract.main([str(a) for a in args] + ["-q"])


def read(p):
    with open(p, "rb") as f:
        return f.read()


# ---------------------------------------------------------------- builders

def pb_varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def pb(fields):
    out = bytearray()
    for fn, v in fields:
        if isinstance(v, int):
            out += pb_varint(fn << 3) + pb_varint(v)
        else:
            out += pb_varint(fn << 3 | 2) + pb_varint(len(v)) + v
    return bytes(out)


def build_payload(parts):
    """parts: {name: (image_bytes, [op kinds])}. Returns payload.bin bytes."""
    data = bytearray()
    pfields = []
    for name, (img, kinds) in parts.items():
        nblocks = len(img) // BS
        ops = []
        per = max(1, nblocks // len(kinds))
        for i, kind in enumerate(kinds):
            start = i * per
            count = per if i < len(kinds) - 1 else nblocks - start
            chunk = img[start * BS:(start + count) * BS]
            if kind == "zero":
                assert chunk == b"\0" * len(chunk)
                op = [(1, 6), (6, pb([(1, start), (2, count)]))]
                ops.append(pb(op))
                continue
            t, enc = {"raw": (0, chunk), "bz": (1, bz2.compress(chunk)),
                      "xz": (8, lzma.compress(chunk)),
                      "zstd": (14, zstandard.ZstdCompressor().compress(chunk) if zstandard else b"")}[kind]
            # Split the destination over two extents to exercise the writer.
            half = count // 2 or count
            ext = [pb([(1, start), (2, half)])]
            if half != count:
                ext.append(pb([(1, start + half), (2, count - half)]))
            op = [(1, t), (2, len(data)), (3, len(enc))] + [(6, e) for e in ext] + \
                 [(8, hashlib.sha256(enc).digest())]
            data += enc
            ops.append(pb(op))
        info = pb([(1, len(img)), (2, hashlib.sha256(img).digest())])
        pfields.append(pb([(1, name.encode()), (7, info)] + [(8, o) for o in ops]))
    manifest = pb([(3, BS)] + [(13, p) for p in pfields])
    hdr = b"CrAU" + struct.pack(">QQI", 2, len(manifest), 0)
    return hdr + manifest + bytes(data)


def build_sparse(img, blk=BS):
    """Raw, fill, don't-care and crc chunks."""
    chunks = []
    nb = len(img) // blk
    i = 0
    while i < nb:
        b = img[i * blk:(i + 1) * blk]
        j = i
        if b == b"\0" * blk:
            while j < nb and img[j * blk:(j + 1) * blk] == b:
                j += 1
            chunks.append(struct.pack("<HHII", 0xCAC3, 0, j - i, 12))
        elif b == b[:4] * (blk // 4):
            while j < nb and img[j * blk:(j + 1) * blk] == b:
                j += 1
            chunks.append(struct.pack("<HHII", 0xCAC2, 0, j - i, 16) + b[:4])
        else:
            while j < nb and img[j * blk:(j + 1) * blk] != b"\0" * blk and j - i < 3:
                j += 1
            chunks.append(struct.pack("<HHII", 0xCAC1, 0, j - i, 12 + (j - i) * blk) + img[i * blk:j * blk])
        i = j
    chunks.append(struct.pack("<HHII", 0xCAC4, 0, 0, 16) + b"\0" * 4)
    hdr = struct.pack("<IHHHHIIII", 0xED26FF3A, 1, 0, 28, 12, blk, nb, len(chunks), 0)
    return hdr + b"".join(chunks)


def build_super(parts):
    """parts: [(name, bytes)]; empty bytes -> partition with no extents.

    Each non-empty partition is split into two non-adjacent extents.
    """
    data_start = 1 << 20
    body = bytearray()
    pentries, extents = [], []
    for name, img in parts:
        first = len(extents)
        if img:
            half = (len(img) // 2) // 512 * 512
            for piece in (img[:half], img[half:]):
                off = data_start + len(body)
                extents.append(struct.pack("<QIQI", len(piece) // 512, 0, off // 512, 0))
                body += piece + b"\xAA" * 4096  # gap between extents
        pentries.append(struct.pack("<36sIIII", name.encode(), 0, first, len(extents) - first, 0))
    groups = [struct.pack("<36sIQ", b"default", 0, 0)]
    bdevs = [struct.pack("<QIIQ36sI", 2048, 0, 0, data_start + len(body), b"super", 0)]
    tables, descs = b"", []
    for entries, esz in ((pentries, 52), (extents, 24), (groups, 48), (bdevs, 64)):
        descs.append(struct.pack("<III", len(tables), len(entries), esz))
        tables += b"".join(entries)
    header = struct.pack("<IHHI32sI32s", 0x414C5030, 10, 2, 256, b"\0" * 32, len(tables), b"\0" * 32)
    header += b"".join(descs) + b"\0" * (256 - 80 - 48)
    geom = struct.pack("<II32sIII", 0x616C4467, 52, b"\0" * 32, 65536, 2, 4096)
    img = bytearray(data_start)
    img[4096:4096 + len(geom)] = geom
    img[8192:8192 + len(geom)] = geom
    md = header + tables
    img[12288:12288 + len(md)] = md
    return bytes(img + body)


def cpio(entries):
    """entries: [(name, mode, data)] -> newc archive."""
    out = bytearray()
    for i, (name, mode, data) in enumerate(entries + [("TRAILER!!!", 0, b"")]):
        nb = name.encode() + b"\0"
        fields = [i + 1, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(nb), 0]
        out += b"070701" + b"".join(b"%08X" % f for f in fields) + nb
        out += b"\0" * (-len(out) % 4) + data
        out += b"\0" * (-len(out) % 4)
    return bytes(out)


RAMDISK_FILES = [("init", 0o100755, b"#!init\n" * 50), ("system", 0o040755, b""),
                 ("system/etc", 0o040755, b""), ("system/etc/fstab", 0o100644, b"/dev/x /x ext4\n"),
                 ("sbin", 0o120777, b"system/bin"), ("../escape", 0o100644, b"nope")]


def pad(b, page):
    return b + b"\0" * (-len(b) % page)


def build_boot_v2(kernel, ramdisk, dtb, page=2048):
    hdr = struct.pack("<8s10I", b"ANDROID!", len(kernel), 0x8000, len(ramdisk), 0x1000000,
                      0, 0, 0x100, page, 2, (11 << 25 | 0 << 18 | 0 << 11) | (21 << 4 | 6))
    hdr += struct.pack("<16s512s32s1024s", b"testboard", b"console=ttyMSM0", b"\0" * 32, b"")
    hdr += struct.pack("<IQI", 0, 0, 1660) + struct.pack("<IQ", len(dtb), 0x1f00000)
    return pad(hdr, page) + pad(kernel, page) + pad(ramdisk, page) + pad(dtb, page)


def build_boot_v4(kernel, ramdisk):
    hdr = struct.pack("<8sIIII4II1536sI", b"ANDROID!", len(kernel), len(ramdisk),
                      (14 << 25) | (24 << 4 | 9), 1584, 0, 0, 0, 0, 4, b"", 0)
    return pad(hdr, 4096) + pad(kernel, 4096) + pad(ramdisk, 4096)


def build_vendor_boot_v4(rd1, rd2, dtb, page=4096):
    table = b""
    for i, (rd, name) in enumerate(((rd1, b"platform"), (rd2, b"dlkm"))):
        off = 0 if i == 0 else len(rd1)
        table += struct.pack("<III32s16I", len(rd), off, 1, name, *([0] * 16))
    hdr = struct.pack("<8sIIIII2048sI16sIIQ", b"VNDRBOOT", 4, page, 0, 0, len(rd1) + len(rd2),
                      b"androidboot.hardware=test", 0, b"vb", 2128, len(dtb), 0)
    hdr += struct.pack("<IIII", len(table), 2, 108, 0)
    return pad(hdr, page) + pad(rd1 + rd2, page) + pad(dtb, page) + pad(table, page)


def stored_zip(path, members):
    with zipfile.ZipFile(path, "w") as z:
        for name, data, method in members:
            z.writestr(zipfile.ZipInfo(name), data, compress_type=method)


# ---------------------------------------------------------------- tests

class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="fwx-")
        self.out = os.path.join(self.d, "out")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def p(self, *a):
        return os.path.join(self.d, *a)

    def o(self, *a):
        return os.path.join(self.out, *a)

    def write(self, name, data):
        with open(self.p(name), "wb") as f:
            f.write(data)
        return self.p(name)


def sample_image(nblocks, seed):
    img = bytearray(blob(nblocks * BS, seed))
    img[BS * 2:BS * 4] = b"\0" * (2 * BS)  # zero run for ZERO / don't-care chunks
    img[BS * 5:BS * 6] = b"\x12\x34\x56\x78" * (BS // 4)  # fill chunk
    return bytes(img)


class PayloadTests(Base):
    def parts(self):
        kinds = ["xz", "raw", "bz"] + (["zstd"] if zstandard else [])
        boot = blob(16 * BS, 1)
        system = bytearray(blob(24 * BS, 2))
        system[8 * BS:16 * BS] = b"\0" * (8 * BS)
        return {"boot": (boot, kinds), "system": (bytes(system), ["raw", "zero", "xz"]),
                "vendor_boot": (blob(8 * BS, 3), ["bz"])}

    def test_payload_bin(self):
        parts = self.parts()
        p = self.write("payload.bin", build_payload(parts))
        self.assertEqual(run(p, "-o", self.out, "--verify"), 0)
        for name, (img, _) in parts.items():
            self.assertEqual(read(self.o(name + ".img")), img, name)

    def test_ota_zip_streams_payload_and_filters(self):
        parts = self.parts()
        z = self.p("ota.zip")
        stored_zip(z, [("META-INF/com/android/metadata", b"ota-type=AB\n", zipfile.ZIP_DEFLATED),
                       ("payload_properties.txt", b"FILE_HASH=x\n", zipfile.ZIP_DEFLATED),
                       ("payload.bin", build_payload(parts), zipfile.ZIP_STORED)])
        self.assertEqual(run(z, "-o", self.out, "-p", "boot"), 0)
        self.assertEqual(sorted(os.listdir(self.out)), ["boot.img"])
        self.assertEqual(read(self.o("boot.img")), parts["boot"][0])

    def test_unknown_partition_is_an_error(self):
        p = self.write("payload.bin", build_payload(self.parts()))
        self.assertEqual(run(p, "-o", self.out, "-p", "nonexistent"), 2)

    def test_corrupt_payload_detected(self):
        raw = bytearray(build_payload({"boot": (blob(4 * BS, 9), ["raw"])}))
        raw[-100] ^= 0xFF
        p = self.write("payload.bin", bytes(raw))
        self.assertEqual(run(p, "-o", self.out), 2)
        self.assertFalse(os.path.exists(self.o("boot.img")))

    def test_delta_payload_refused(self):
        op = pb([(1, 4), (4, pb([(1, 0), (2, 1)])), (6, pb([(1, 0), (2, 1)]))])
        part = pb([(1, b"boot"), (7, pb([(1, BS)])), (8, op)])
        manifest = pb([(3, BS), (12, 7), (13, part)])
        p = self.write("payload.bin", b"CrAU" + struct.pack(">QQI", 2, len(manifest), 0) + manifest)
        self.assertEqual(run(p, "-o", self.out), 2)


class SparseSuperTests(Base):
    def test_sparse_to_raw(self):
        img = sample_image(12, 4)
        p = self.write("system.img", build_sparse(img))
        self.assertEqual(run(p, "-o", self.out), 0)
        self.assertEqual(read(self.o("system.img")), img)

    def test_sparse_in_place_does_not_clobber_input(self):
        img = sample_image(8, 5)
        p = self.write("vendor.img", build_sparse(img))
        self.assertEqual(run(p, "-o", self.d), 0)
        self.assertEqual(read(self.p("vendor.raw.img")), img)
        self.assertEqual(read(p)[:4], b"\x3a\xff\x26\xed")

    def test_super_and_sparse_super(self):
        system, vendor = sample_image(10, 6), blob(6 * BS, 7)
        sup = build_super([("system_a", system), ("vendor_a", vendor), ("system_b", b"")])
        p = self.write("super.img", build_sparse(sup))
        self.assertEqual(run(p, "-o", self.out), 0)
        self.assertEqual(read(self.o("system_a.img")), system)
        self.assertEqual(read(self.o("vendor_a.img")), vendor)
        self.assertFalse(os.path.exists(self.o("system_b.img")))
        # The unsparsed super was an intermediate; it is removed unless --keep.
        self.assertFalse(os.path.exists(self.o("super.img")))

    def test_super_filter_with_slot_suffix(self):
        sup = build_super([("system_a", blob(4 * BS, 1)), ("vendor_a", blob(4 * BS, 2))])
        p = self.write("super.img", sup)
        self.assertEqual(run(p, "-o", self.out, "-p", "vendor"), 0)
        self.assertEqual(sorted(os.listdir(self.out)), ["vendor_a.img"])

    def test_sparsechunk_set(self):
        img = sample_image(16, 8)
        # Split like Motorola: each file covers the whole image, rest don't-care.
        a = img[:8 * BS] + b"\0" * (8 * BS)
        b = b"\0" * (8 * BS) + img[8 * BS:]
        z = self.p("fw.zip")
        stored_zip(z, [("system.img_sparsechunk.0", build_sparse(a), zipfile.ZIP_DEFLATED),
                       ("system.img_sparsechunk.1", build_sparse(b), zipfile.ZIP_DEFLATED)])
        self.assertEqual(run(z, "-o", self.out), 0)
        self.assertEqual(read(self.o("system.img")), img)
        self.assertFalse(os.path.exists(self.o("system.img_sparsechunk.0")))


class BootTests(Base):
    def test_boot_v2_gzip_ramdisk(self):
        kernel, dtb = blob(10000, 1), b"\xd0\x0d\xfe\xed" + blob(3000, 2)
        rd = gzip.compress(cpio(RAMDISK_FILES))
        p = self.write("boot.img", build_boot_v2(kernel, rd, dtb))
        self.assertEqual(run(p, "-o", self.out, "--unpack-boot"), 0)
        u = self.o("boot_unpacked")
        self.assertEqual(read(os.path.join(u, "kernel")), kernel)
        self.assertEqual(read(os.path.join(u, "dtb")), dtb)
        self.assertEqual(read(os.path.join(u, "ramdisk")), rd)
        files = os.path.join(u, "ramdisk_files")
        self.assertEqual(read(os.path.join(files, "init")), b"#!init\n" * 50)
        self.assertEqual(read(os.path.join(files, "system/etc/fstab")), b"/dev/x /x ext4\n")
        link = os.path.join(files, "sbin")
        self.assertTrue(os.path.islink(link) or os.path.exists(link + ".symlink"))
        self.assertFalse(os.path.exists(os.path.join(self.out, "escape")))
        self.assertFalse(os.path.exists(os.path.join(u, "escape")))
        info = read(os.path.join(u, "bootimg.txt")).decode()
        self.assertIn("console=ttyMSM0", info)
        self.assertIn("Android 11.0.0, patch 2021-06", info)

    def test_boot_v4_lz4_legacy_ramdisk_pure_python(self):
        archive = cpio(RAMDISK_FILES)
        # lz4 legacy stream, written with our own encoder of literals only
        # so the test needs no lz4 module: a block that is all literals.
        block = bytearray()
        lit = len(archive)
        block.append(0xF0)
        lit -= 15
        while lit >= 255:
            block.append(255)
            lit -= 255
        block.append(lit)
        block += archive
        rd = struct.pack("<II", fwextract.LZ4_LEGACY_MAGIC, len(block)) + bytes(block)
        kernel = blob(5000, 3)
        p = self.write("init_boot.img", build_boot_v4(kernel, rd))
        self.assertEqual(run(p, "-o", self.out, "--unpack-boot"), 0)
        u = self.o("init_boot_unpacked")
        self.assertEqual(read(os.path.join(u, "ramdisk_files", "init")), b"#!init\n" * 50)
        self.assertIn("compression: lz4", read(os.path.join(u, "bootimg.txt")).decode())

    def test_vendor_boot_v4(self):
        rd1 = gzip.compress(cpio([("first_stage_ramdisk", 0o040755, b""),
                                  ("first_stage_ramdisk/fstab.test", 0o100644, b"fstab")]))
        rd2 = gzip.compress(cpio([("lib", 0o040755, b""), ("lib/modules.load", 0o100644, b"a.ko\n")]))
        p = self.write("vendor_boot.img", build_vendor_boot_v4(rd1, rd2, b"\xd0\x0d\xfe\xed" * 50))
        self.assertEqual(run(p, "-o", self.out, "--unpack-boot"), 0)
        u = self.o("vendor_boot_unpacked")
        self.assertEqual(read(os.path.join(u, "vendor_ramdisk_platform_files",
                                           "first_stage_ramdisk", "fstab.test")), b"fstab")
        self.assertEqual(read(os.path.join(u, "vendor_ramdisk_dlkm_files", "lib", "modules.load")), b"a.ko\n")

    def test_boot_left_alone_without_flag(self):
        p = self.write("boot.img", build_boot_v4(b"k" * 100, gzip.compress(cpio([]))))
        self.assertEqual(run(p, "-o", self.out), 0)
        self.assertFalse(os.path.exists(self.o("boot_unpacked")))


class Lz4Tests(Base):
    @unittest.skipUnless(lz4, "lz4 module not installed")
    def test_pure_python_block_decoder_matches_reference(self):
        for seed in range(5):
            data = blob(200000, seed) + b"\0" * 5000 + b"ab" * 3000
            comp = lz4.block.compress(data, store_size=False)
            self.assertEqual(fwextract.lz4_block(comp), data)

    @unittest.skipUnless(lz4, "lz4 module not installed")
    def test_pure_python_frame_decoder_linked_blocks(self):
        data = blob(600000, 11)
        for linked in (True, False):
            comp = lz4.frame.compress(data, block_size=lz4.frame.BLOCKSIZE_MAX64KB,
                                      block_linked=linked, content_checksum=True)
            out = io.BytesIO()
            fwextract.lz4_stream(io.BytesIO(comp), out)
            self.assertEqual(out.getvalue(), data)

    @unittest.skipUnless(lz4, "lz4 module not installed")
    def test_samsung_tar_md5(self):
        boot = build_boot_v4(blob(3000, 1), gzip.compress(cpio(RAMDISK_FILES)))
        system, product = sample_image(8, 2), blob(4 * BS, 3)
        sup = build_sparse(build_super([("system", system), ("product", product)]))
        tpath = self.p("AP_TEST.tar")
        with tarfile.open(tpath, "w", format=tarfile.USTAR_FORMAT) as t:
            for name, data in (("boot.img.lz4", lz4.frame.compress(boot)),
                               ("super.img.lz4", lz4.frame.compress(sup)),
                               ("vbmeta.img.lz4", lz4.frame.compress(b"AVB0" + b"\0" * 4092))):
                ti = tarfile.TarInfo(name)
                ti.size = len(data)
                t.addfile(ti, io.BytesIO(data))
        md5 = hashlib.md5(read(tpath)).hexdigest()
        with open(tpath, "ab") as f:
            f.write(("%s  AP_TEST.tar\n" % md5).encode())
        os.rename(tpath, tpath + ".md5")
        self.assertEqual(run(tpath + ".md5", "-o", self.out, "-p", "boot,system"), 0)
        self.assertEqual(sorted(os.listdir(self.out)), ["boot.img", "system.img"])
        self.assertEqual(read(self.o("boot.img")), boot)
        self.assertEqual(read(self.o("system.img")), system)


class OtherFormatTests(Base):
    @unittest.skipUnless(brotli, "brotli module not installed")
    def test_block_ota_new_dat_br(self):
        img = blob(10 * BS, 5)
        # Write blocks 0-3 and 6-9; 4-5 stay zero.
        new_dat = img[:4 * BS] + img[6 * BS:]
        tl = "4\n10\n0\n0\nerase 2,0,10\nnew 4,0,4,6,10\nzero 2,4,6\n"
        img = img[:4 * BS] + b"\0" * (2 * BS) + img[6 * BS:]
        z = self.p("rom.zip")
        stored_zip(z, [("system.transfer.list", tl.encode(), zipfile.ZIP_DEFLATED),
                       ("system.new.dat.br", brotli.compress(new_dat), zipfile.ZIP_STORED),
                       ("system.patch.dat", b"", zipfile.ZIP_STORED)])
        self.assertEqual(run(z, "-o", self.out), 0)
        self.assertEqual(read(self.o("system.img")), img)
        self.assertFalse(os.path.exists(self.o("system.new.dat.br")))

    def test_nested_factory_zip(self):
        boot = build_boot_v4(b"kernel" * 100, gzip.compress(cpio([])))
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w") as z:
            z.writestr("boot.img", boot)
            z.writestr("system.img", build_sparse(sample_image(6, 1)))
        outer = self.p("factory.zip")
        stored_zip(outer, [("dev-1/flash-all.sh", b"#!/bin/sh\n", zipfile.ZIP_DEFLATED),
                           ("dev-1/bootloader-dev.img", b"BL" * 100, zipfile.ZIP_DEFLATED),
                           ("dev-1/image-dev-1.zip", inner.getvalue(), zipfile.ZIP_STORED)])
        self.assertEqual(run(outer, "-o", self.out, "-p", "boot"), 0)
        self.assertEqual(read(self.o("dev-1", "image-dev-1", "boot.img")), boot)
        self.assertFalse(os.path.exists(self.o("dev-1", "bootloader-dev.img")))
        self.assertFalse(os.path.exists(self.o("dev-1", "image-dev-1.zip")))

    def test_xz_wrapped_image(self):
        img = sample_image(6, 3)
        p = self.write("system.img.xz", lzma.compress(build_sparse(img)))
        self.assertEqual(run(p, "-o", self.out), 0)
        self.assertEqual(read(self.o("system.img")), img)

    @unittest.skipUnless(shutil.which("mkfs.ext4") and shutil.which("debugfs"), "e2fsprogs missing")
    def test_unpack_ext4(self):
        src = self.p("root")
        os.makedirs(os.path.join(src, "etc"))
        with open(os.path.join(src, "etc", "build.prop"), "w") as f:
            f.write("ro.build.version.release=16\n")
        img = self.p("vendor.img")
        subprocess.run(["mkfs.ext4", "-q", "-d", src, img, "4M"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.assertEqual(run(img, "-o", self.out, "--unpack-fs"), 0)
        found = [os.path.join(r, n) for r, _, ns in os.walk(self.o("vendor_files")) for n in ns]
        self.assertTrue(any(f.endswith("build.prop") for f in found), found)

    def test_list_writes_nothing(self):
        p = self.write("payload.bin", build_payload({"boot": (blob(4 * BS, 1), ["raw"])}))
        old = os.getcwd()
        os.chdir(self.d)
        try:
            self.assertEqual(run(p, "--list"), 0)
        finally:
            os.chdir(old)
        self.assertEqual(os.listdir(self.d), ["payload.bin"])


class ErrorHandlingTests(Base):
    """What a user sees when the input is wrong, damaged or interrupted."""

    def test_truncated_payload_leaves_no_partial_files(self):
        raw = build_payload({"boot": (blob(8 * BS, 1), ["raw"]), "system": (blob(64 * BS, 2), ["raw"])})
        p = self.write("payload.bin", raw[: len(raw) - 100 * BS])
        self.assertEqual(run(p, "-o", self.out), 2)
        self.assertEqual(read(self.o("boot.img")), blob(8 * BS, 1))
        self.assertEqual(sorted(os.listdir(self.out)), ["boot.img"])

    def test_truncated_zip(self):
        z = self.p("ota.zip")
        stored_zip(z, [("payload.bin", build_payload({"boot": (blob(8 * BS, 1), ["raw"])}), zipfile.ZIP_STORED)])
        p = self.write("cut.zip", read(z)[:20000])
        self.assertEqual(run(p, "-o", self.out), 2)

    def test_corrupt_payload_header_is_not_a_crash(self):
        p = self.write("payload.bin", b"CrAU" + struct.pack(">QQI", 2, 1 << 62, 0) + b"x" * 1000)
        self.assertEqual(run(p, "-o", self.out), 2)

    def test_not_firmware(self):
        p = self.write("notes.txt", b"hello\n")
        self.assertEqual(run(p, "-o", self.out), 1)
        self.assertFalse(os.path.exists(self.out))

    def test_partition_filter_that_matches_nothing(self):
        sup = build_super([("system", blob(4 * BS, 1))])
        tpath = self.p("AP_X.tar")
        with tarfile.open(tpath, "w") as t:
            ti = tarfile.TarInfo("super.img")
            ti.size = len(sup)
            t.addfile(ti, io.BytesIO(sup))
        self.assertEqual(run(tpath, "-o", self.out, "-p", "bot"), 2)
        self.assertEqual(os.listdir(self.out), [])  # intermediate super removed

    def test_simg_name_becomes_img(self):
        img = sample_image(6, 2)
        p = self.write("system.simg", build_sparse(img))
        self.assertEqual(run(p, "-o", self.out), 0)
        self.assertEqual(read(self.o("system.img")), img)

    def test_default_output_dir_name(self):
        tpath = self.p("AP_X.tar.md5")
        with tarfile.open(tpath, "w") as t:
            ti = tarfile.TarInfo("vbmeta.img")
            ti.size = 4
            t.addfile(ti, io.BytesIO(b"AVB0"))
        old = os.getcwd()
        os.chdir(self.d)
        try:
            self.assertEqual(run(tpath), 0)
        finally:
            os.chdir(old)
        self.assertTrue(os.path.exists(self.p("AP_X_extracted", "vbmeta.img")))

    def test_symlinks_on_shared_storage(self):
        archive = cpio([("init", 0o100755, b"x"), ("bin", 0o120777, b"/system/bin")])
        p = self.write("boot.img", build_boot_v4(b"k" * 100, gzip.compress(archive)))
        real = os.symlink

        def refuse(*a, **k):  # FUSE-backed /sdcard refuses symlinks
            raise PermissionError(1, "Operation not permitted")
        os.symlink = refuse
        try:
            self.assertEqual(run(p, "-o", self.out, "--unpack-boot"), 0)
        finally:
            os.symlink = real
        files = self.o("boot_unpacked", "ramdisk_files")
        self.assertEqual(read(os.path.join(files, "bin.symlink")), b"/system/bin\n")


if __name__ == "__main__":
    unittest.main()
