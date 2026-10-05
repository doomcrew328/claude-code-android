#!/usr/bin/env bash
# fwextract-crosscheck.sh: check tools/fwextract.py against the real AOSP tools.
#
# tests/fwextract-tests.py builds its fixtures with the extractor author's own
# understanding of each format. This script instead builds them with the
# tools Google ships (mkbootimg, img2simg, mkfs.erofs) and compares the
# extractor's output with the matching AOSP unpacker (unpack_bootimg,
# simg2img) and with the original inputs, byte for byte.
#
# Runs on a Linux PC or CI, not on the phone. On Debian/Ubuntu:
#   sudo apt-get install mkbootimg android-sdk-libsparse-utils erofs-utils \
#        e2fsprogs lz4 zstd brotli cpio xz-utils
#
# Usage:
#   bash tests/fwextract-crosscheck.sh
#
# Exit codes: 0 all checks passed, 1 a check failed or a tool is missing.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FW=(python3 "$HERE/../tools/fwextract.py" -q)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
PASSES=0

for t in mkbootimg unpack_bootimg img2simg simg2img mkfs.erofs fsck.erofs mkfs.ext4 debugfs lz4 zstd xz cpio; do
  command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t"; exit 1; }
done

# Ubuntu's mkbootimg package imports a GKI signing module it does not ship.
# Signing is not used here, so a stub is enough.
mkdir -p "$WORK/stub/gki"
: > "$WORK/stub/gki/__init__.py"
echo 'def generate_gki_certificate(*a, **k): raise SystemExit("not available")' \
  > "$WORK/stub/gki/generate_gki_certificate.py"
export PYTHONPATH="$WORK/stub${PYTHONPATH:+:$PYTHONPATH}"

pass() { PASSES=$((PASSES+1)); echo "PASS  $1"; }
fail() { FAILS=$((FAILS+1)); echo "FAIL  $1"; }
same() { cmp -s "$1" "$2"; }
same_tree() { diff -r --no-dereference -x lost+found "$1" "$2" >/dev/null 2>&1; }

cd "$WORK" || exit 1

# ---- inputs ---------------------------------------------------------------
mkdir -p rd/system/etc rd/first_stage_ramdisk
for _ in $(seq 500); do echo "init binary"; done > rd/init
chmod 755 rd/init
echo "/dev/block/by-name/system /system ext4 ro" > rd/system/etc/fstab.qcom
ln -s /system/bin rd/bin
head -c 300000 /dev/urandom > rd/blob.bin
(cd rd && find . | LC_ALL=C sort | cpio -o -H newc --quiet) > ramdisk.cpio
gzip -9nc ramdisk.cpio > rd.gz
lz4 -lq -9 -f ramdisk.cpio rd.lz4l       # legacy lz4, what Android kernels use
lz4 -q -f ramdisk.cpio rd.lz4f
xz -c --check=crc32 ramdisk.cpio > rd.xz
zstd -q -c ramdisk.cpio > rd.zst
head -c 7000123 /dev/urandom > kernel
head -c 50001 /dev/urandom > dtb
head -c 12345 /dev/urandom > second
head -c 4321 /dev/urandom > rdtbo

# ---- boot images: every header version x every ramdisk compression --------
for hv in 0 1 2 3 4; do
  for rd in rd.gz rd.lz4l rd.lz4f rd.xz rd.zst; do
    args=(--kernel kernel --ramdisk "$rd" --header_version "$hv" --os_version 14.0.0
          --os_patch_level 2024-09 --cmdline "console=ttyMSM0,115200n8")
    [ "$hv" -lt 3 ] && args+=(--second second --pagesize 4096 --board myboard)
    [ "$hv" -eq 1 ] || [ "$hv" -eq 2 ] && args+=(--recovery_dtbo rdtbo)
    [ "$hv" -eq 2 ] && args+=(--dtb dtb)
    rm -rf o ref
    mkbootimg "${args[@]}" -o boot.img
    "${FW[@]}" boot.img -o o --unpack-boot
    unpack_bootimg --boot_img boot.img --out ref >/dev/null
    u=o/boot_unpacked
    ok=1
    same "$u/kernel" ref/kernel && same "$u/ramdisk" ref/ramdisk || ok=0
    if [ "$hv" -lt 3 ]; then same "$u/second" ref/second || ok=0; fi
    if [ "$hv" -eq 1 ] || [ "$hv" -eq 2 ]; then same "$u/recovery_dtbo" ref/recovery_dtbo || ok=0; fi
    if [ "$hv" -eq 2 ]; then same "$u/dtb" ref/dtb || ok=0; fi
    same_tree rd "$u/ramdisk_files" || ok=0
    [ "$(stat -c %a "$u/ramdisk_files/init")" = 755 ] || ok=0
    grep -q "patch 2024-09" "$u/bootimg.txt" && grep -q "console=ttyMSM0,115200n8" "$u/bootimg.txt" || ok=0
    if [ "$ok" = 1 ]; then pass "boot v$hv, ramdisk $rd"; else fail "boot v$hv, ramdisk $rd"; fi
  done
done

# ---- vendor_boot v4 with three ramdisk fragments ---------------------------
rm -rf o ref
mkbootimg --header_version 4 --vendor_boot vb.img --dtb dtb --pagesize 4096 \
  --vendor_cmdline androidboot.hardware=qcom --vendor_ramdisk rd.gz \
  --ramdisk_type platform --ramdisk_name plat --vendor_ramdisk_fragment rd.lz4l \
  --ramdisk_type dlkm --ramdisk_name dlkm --vendor_ramdisk_fragment rd.xz \
  --vendor_bootconfig second
"${FW[@]}" vb.img -o o --unpack-boot
unpack_bootimg --boot_img vb.img --out ref >/dev/null
u=o/vb_unpacked
if same "$u/vendor_ramdisk_ramdisk0" ref/vendor_ramdisk00 && same "$u/vendor_ramdisk_plat" ref/vendor_ramdisk01 \
   && same "$u/vendor_ramdisk_dlkm" ref/vendor_ramdisk02 && same "$u/dtb" ref/dtb \
   && same "$u/bootconfig" ref/bootconfig && same_tree rd "$u/vendor_ramdisk_dlkm_files"; then
  pass "vendor_boot v4"
else
  fail "vendor_boot v4"
fi

# ---- sparse images (img2simg) -------------------------------------------
mkdir -p tree/etc tree/app/Foo
echo "ro.build.version.release=16" > tree/etc/build.prop
head -c 3000000 /dev/urandom > tree/app/Foo/Foo.apk
ln -s ../etc/build.prop tree/etc/prop
mkfs.ext4 -q -b 4096 -d tree system.img 64M >/dev/null 2>&1
for bs in 4096 65536; do
  rm -rf o
  img2simg system.img system.simg "$bs"
  simg2img system.simg ref.raw
  "${FW[@]}" system.simg -o o
  if same o/system.img ref.raw; then pass "sparse ($bs-byte blocks) matches simg2img"; else fail "sparse ($bs-byte blocks)"; fi
done

# ---- filesystems -----------------------------------------------------------
rm -rf o
"${FW[@]}" system.img -o o --unpack-fs
if same_tree tree o/system_files; then pass "ext4 files (debugfs)"; else fail "ext4 files (debugfs)"; fi
for z in "" "-zlz4hc"; do
  rm -rf o vendor.img
  # shellcheck disable=SC2086  # empty $z must vanish
  mkfs.erofs --quiet $z vendor.img tree >/dev/null
  "${FW[@]}" vendor.img -o o --unpack-fs
  if same_tree tree o/vendor_files; then pass "erofs files ${z:-uncompressed}"; else fail "erofs files ${z:-uncompressed}"; fi
done

# ---- Samsung-style tar.md5 with lz4 members (lz4 CLI like Odin packages) ---
rm -rf o
lz4 -q -B6 --content-size system.simg system.img.lz4
lz4 -q boot.img boot.img.lz4
tar -H ustar -cf AP_TEST.tar boot.img.lz4 system.img.lz4
md5sum AP_TEST.tar >> AP_TEST.tar
mv AP_TEST.tar AP_TEST.tar.md5
"${FW[@]}" AP_TEST.tar.md5 -o o -p boot,system
if same o/boot.img boot.img && same o/system.img ref.raw; then pass "Samsung tar.md5 + lz4 + sparse"; else fail "Samsung tar.md5"; fi

echo
echo "$PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
