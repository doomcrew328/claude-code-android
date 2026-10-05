# Firmware Extractor

`tools/fwextract.py` pulls partition images out of Android firmware packages on the phone itself, in Termux. No PC, no root, and nothing beyond `pkg install python`.

The usual reason to want this: you downloaded an OTA or factory image and need `boot.img` or `init_boot.img` to patch with Magisk or KernelSU, or you want to look at a ROM's `system`, `vendor` or ramdisk without moving gigabytes to a computer.

---

## Install

One command installs everything, puts `fwextract` on your PATH, and runs the test suite on your phone to prove it works there:

```bash
pkg install git
git clone https://github.com/ferrumclaudepilgrim/claude-code-android.git ~/claude-code-android   # skip if you already have it
bash ~/claude-code-android/tools/setup-fwextract.sh
termux-setup-storage          # once, so Termux can read ~/storage/downloads
```

What the setup script installs (all from the normal Termux repositories, no root):

| Package | Gives | Needed for |
|---|---|---|
| `python` | Python 3 | everything |
| `lz4` | `lz4` | fast Samsung `.img.lz4` files. Without it a built-in Python decoder is used, which works but takes many minutes on a multi-GB `super.img.lz4`. |
| `zstd` | `zstd` | OTAs with `REPLACE_ZSTD` operations and `.zst` images (Python 3.14+ also decodes zstd itself) |
| `brotli` | `brotli` | block-based ROM zips with `system.new.dat.br` |
| `e2fsprogs` | `debugfs` | `--unpack-fs` on ext4 images |
| `erofs-utils` (from `root-repo`) | `fsck.erofs` | `--unpack-fs` on erofs images. `root-repo` is just a second package repository; installing from it does not need a rooted phone. |

The script finishes with exit code 0 when everything is in place, or 3 if an optional helper could not be installed (the extractor still works; the summary names the one command to retry). Check at any time with:

```bash
fwextract --check
```

After a `git pull`, re-run the setup script to update the installed `fwextract`.

Inside proot Ubuntu (Path B) the same script uses `apt-get` instead of `pkg`. On a normal Linux PC it installs `fwextract` to `~/.local/bin` and prints the `apt-get` line to run yourself.

Without the setup script, the tool also runs straight from the repo with nothing but Python: `python ~/claude-code-android/tools/fwextract.py --help`.

---

## Examples

```bash
cd ~/storage/downloads

# What is inside? Writes nothing.
fwextract ota.zip --list

# Just the images Magisk / KernelSU need, straight out of the OTA zip.
fwextract ota.zip -p boot,init_boot

# Everything in the OTA.
fwextract ota.zip -o ~/fw

# Samsung: the AP file from a firmware download.
fwextract AP_S928BXXU3AXXX.tar.md5 -p boot,init_boot,vbmeta

# Split a super image into system / vendor / product / ...
fwextract super.img -o ~/parts

# Look inside a boot image: kernel, ramdisk files, dtb, cmdline, patch level.
fwextract boot.img --unpack-boot

# Copy the files out of ext4 / erofs partitions too (see "Filesystems" below).
fwextract ota.zip -p vendor --unpack-fs
```

Output goes to `<input name>_extracted/` in the current directory unless you pass `-o`.

---

## What it handles

Formats are detected by their magic bytes, not their file names, and containers are followed all the way down. A Samsung AP tar, for example, becomes `super.img.lz4`, then a sparse `super.img`, then a raw super image, then `system.img`, `vendor.img`, `product.img`.

| Input | Result |
|---|---|
| A/B OTA zip (`payload.bin` inside) | Partition images. The payload is read in place inside the zip, so a 3 GB OTA does not need another 3 GB free just to unzip it. |
| `payload.bin` | Partition images. Supports full OTAs (`REPLACE`, `REPLACE_BZ`, `REPLACE_XZ`, `REPLACE_ZSTD`, `ZERO`, `DISCARD`). Every operation's SHA-256 from the manifest is checked; `--verify` also re-hashes each finished image. |
| Factory image zip (Pixel style, nested `image-*.zip`) | The images from the inner zip. |
| Android sparse image | Raw image. |
| `*_sparsechunk.0`, `.1`, ... (Motorola) | One merged raw image. |
| `super.img` (dynamic partitions) | One image per logical partition; empty slot-B partitions are skipped. |
| `boot.img`, `init_boot.img`, `recovery.img` (header v0 to v4) | Kept as is; with `--unpack-boot`: `kernel`, `ramdisk`, `second`, `dtb`, `recovery_dtbo`, the unpacked ramdisk files, and `bootimg.txt` (cmdline, OS version, security patch level). |
| `vendor_boot.img` (v3, v4) | With `--unpack-boot`: each named vendor ramdisk unpacked separately, plus `dtb` and `bootconfig`. |
| Samsung `.tar` / `.tar.md5` | The images inside, decompressed from `.lz4`. |
| Block-based OTA (`*.transfer.list` + `*.new.dat` or `*.new.dat.br`) | Raw image (the `sdat2img` conversion). |
| `.lz4`, `.zst`, `.gz`, `.xz`, `.bz2`, `.tgz` | Decompressed, then inspected again. Xiaomi fastboot `.tgz` packages work this way. |
| ext4 / erofs images | Kept as is; with `--unpack-fs`: the files inside (needs an external tool, below). |

Ramdisk compression: gzip, lz4 (legacy and frame), xz, lzma, bzip2, zstd.

### Options

| Option | Effect |
|---|---|
| `-o DIR` | Output directory. |
| `-p a,b,c` | Only these partitions. `system` also matches `system_a`. Containers (zips, tars, `super`) are still opened to find them. |
| `-l`, `--list` | Describe the input and exit. |
| `--unpack-boot` | Also split boot-type images. |
| `--unpack-fs` | Also copy files out of ext4 / erofs images. |
| `--verify` | Re-hash each extracted `payload.bin` partition against the manifest. |
| `--keep` | Keep intermediates (the decompressed `super.img` after splitting it, nested zips, `.lz4` files). By default the tool deletes files it created on the way, to save phone storage. Your input file is never modified or deleted. |
| `-q` | Warnings and errors only. |

Exit codes: `0` everything extracted, `1` could not start (bad input), `2` finished but some items failed (each one is printed as a warning).

---

## What it does not do

- **Incremental (delta) OTAs.** These contain patches against the partition already on your phone, not full images. The tool says so and skips those partitions. Download the full OTA (Google calls these "Full OTA images"; most other vendors call them full or "recovery" ROM packages).
- **Retrofit dynamic partitions** whose `super` spans several physical partitions. Only the super image itself is read.
- **Encrypted or signed-and-encrypted packages** (some vendors' `.ozip`, `.ofp`, `.ops`, `.kdz`, `.pac`, Huawei `UPDATE.APP`). Decrypt or convert them first with a vendor-specific tool.
- **Filesystem extraction without an external tool.** See below.

---

## Filesystems

`--unpack-fs` hands ext4 and erofs images to existing tools instead of reimplementing two filesystems:

- ext4: `debugfs` (from e2fsprogs) on PATH, run as `debugfs -R "rdump / <dir>" <image>`.
- erofs: `fsck.erofs` (from erofs-utils) on PATH, run as `fsck.erofs --extract=<dir> <image>`.

If the tool is missing the image is left as is and a warning names what to install. Both are standard in Ubuntu, so inside a proot-Ubuntu (Path B) environment `apt install e2fsprogs erofs-utils` provides them.

---

## Storage tips

- Partition images are big. `system` alone is often 2 to 4 GB, and `super` holds all of them. The extractor warns before starting if the output directory does not have room for what you asked for; use `-p` to take only what you need.
- Writing output to Termux's home (`-o ~/fw`) is faster than shared storage and keeps ramdisk symlinks intact. Shared storage (`~/storage/...`, `/sdcard`) cannot hold symlinks, so those are written as small `<name>.symlink` text files containing the link target.
- To flash or patch an image, copy just that file to shared storage afterwards, for example `cp ~/fw/init_boot.img ~/storage/downloads/`.

---

## Tests

```bash
python3 tests/fwextract-tests.py -v      # any machine, standard library only
bash tests/fwextract-crosscheck.sh       # Linux PC/CI, needs the AOSP tools listed in the script
```

`fwextract-tests.py` builds small firmware files in each supported format, including damaged and truncated ones, and checks the output byte for byte. It needs only the standard library; the lz4, zstd and brotli cases run when the matching Python modules are installed (`pip install lz4 zstandard brotli`) and are skipped otherwise.

`fwextract-crosscheck.sh` builds its inputs with Google's own tools instead: `mkbootimg` for boot and vendor_boot images (header v0 to v4, five ramdisk compressions), `img2simg` for sparse images, `mkfs.erofs` / `mkfs.ext4` for filesystems, and the `lz4` CLI for Samsung-style packages. It then compares the output with `unpack_bootimg`, `simg2img` and the original inputs. CI runs both (`.github/workflows/fwextract.yml`).

What has been checked beyond those two suites:

- `payload.bin` built with AOSP's compiled `update_metadata.proto` (2 MiB operations, REPLACE / REPLACE_BZ / REPLACE_XZ / ZERO, signatures and metadata signature present, inside a stored OTA zip) extracts identically to the source images and to the independent `payload_dumper` tool.
- `super.img` written by AOSP's own `liblp` (`MetadataBuilder` + `WriteToImageFile`), raw and sparse, with empty slot-B partitions, splits into images identical to the inputs.
- Block OTAs (`transfer.list` + `new.dat.br`) convert identically to the reference `sdat2img.py`.
- A 2 GiB partition extracted from an OTA zip in about 25 s with a peak memory use of about 31 MiB, so a phone with little free RAM is fine.
- Python 3.8, 3.11, 3.13 and 3.14 (3.14 uses its built-in zstd).

Not yet checked: a run on an actual phone in Termux, and real vendor firmware downloads (the test environment had no access to Google's or Samsung's download servers).
