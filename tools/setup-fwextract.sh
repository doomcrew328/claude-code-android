#!/usr/bin/env bash
# setup-fwextract.sh: one-time setup for the firmware extractor.
#
# Installs everything tools/fwextract.py can use, puts a `fwextract`
# command on your PATH, and runs the test suite on this device to prove
# it all works here.
#
#   Termux (native):  pkg install python lz4 zstd brotli e2fsprogs
#                     pkg install root-repo && pkg install erofs-utils
#                     (root-repo is just another package repository; it
#                     does not need a rooted phone)
#   proot Ubuntu / Debian as root:  apt-get install the same tools
#
# Safe to re-run; re-running also updates the installed `fwextract` to the
# version in this checkout (do that after a `git pull`).
#
# Usage:
#   bash tools/setup-fwextract.sh
#
# Exit codes:
#   0 = installed, every helper present, self-test passed
#   1 = a required step failed (Python, copying the tool, or the self-test)
#   3 = installed and working, but an optional helper is missing

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TOOL="$REPO/tools/fwextract.py"
TESTS="$REPO/tests/fwextract-tests.py"

IN_TERMUX=0
case "${PREFIX:-}" in
  /data/data/com.termux/*) IN_TERMUX=1 ;;
esac

step() { printf '\n==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ -f "$TOOL" ] || die "cannot find $TOOL (run this from a clone of the repo)"

OPTIONAL_OK=1
if [ "$IN_TERMUX" = 1 ]; then
  step "Installing Python and helper tools (pkg)"
  pkg install -y python lz4 zstd brotli e2fsprogs || die "pkg install failed (check your network or run: termux-change-repo)"

  step "Installing erofs-utils from root-repo (no root needed)"
  if ! { pkg install -y root-repo && pkg install -y erofs-utils; }; then
    echo "warning: erofs-utils did not install; only --unpack-fs on erofs images needs it"
    OPTIONAL_OK=0
  fi
  BIN="$PREFIX/bin"
  SHARE="$PREFIX/share/fwextract"
elif command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  # proot-distro Ubuntu/Debian (Path B) runs as root, so apt works directly.
  step "Installing Python and helper tools (apt-get)"
  apt-get update -q || die "apt-get update failed"
  apt-get install -y -q python3 lz4 zstd brotli e2fsprogs || die "apt-get install failed"
  apt-get install -y -q erofs-utils || { echo "warning: erofs-utils did not install"; OPTIONAL_OK=0; }
  BIN=/usr/local/bin
  SHARE=/usr/local/share/fwextract
else
  step "Not Termux and not root: skipping package installation"
  echo "Install the helpers with your package manager, for example:"
  echo "  sudo apt-get install python3 lz4 zstd brotli e2fsprogs erofs-utils"
  BIN="$HOME/.local/bin"
  SHARE="$HOME/.local/share/fwextract"
fi

PY="$(command -v python3 || true)"
[ -n "$PY" ] || die "python3 not found after installation"

step "Installing the fwextract command"
mkdir -p "$BIN" "$SHARE" || die "cannot create $BIN or $SHARE"
cp "$TOOL" "$SHARE/fwextract.py" || die "cannot copy fwextract.py"
SH="$(command -v sh)"
# Absolute paths, so it also works where /usr/bin/env does not exist
# (Termux without termux-exec, e.g. when launched from a glibc binary).
cat > "$BIN/fwextract" <<EOF
#!$SH
exec "$PY" "$SHARE/fwextract.py" "\$@"
EOF
chmod 755 "$BIN/fwextract" || die "cannot make $BIN/fwextract executable"
echo "installed: $BIN/fwextract -> $SHARE/fwextract.py"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "note: $BIN is not on your PATH; add this to ~/.bashrc:  export PATH=\"$BIN:\$PATH\"" ;;
esac

step "Checking helper tools"
"$BIN/fwextract" --check
rc=$?
[ "$rc" = 0 ] || OPTIONAL_OK=0

step "Running the self-test on this device"
if [ -f "$TESTS" ]; then
  if "$PY" "$TESTS" >"${TMPDIR:-/tmp}/fwextract-selftest.log" 2>&1; then
    echo "self-test passed ($(grep -o 'Ran [0-9]* tests' "${TMPDIR:-/tmp}/fwextract-selftest.log"))"
  else
    tail -20 "${TMPDIR:-/tmp}/fwextract-selftest.log"
    die "self-test failed; full log: ${TMPDIR:-/tmp}/fwextract-selftest.log"
  fi
else
  echo "tests not found next to the tool; skipped"
fi

if [ "$IN_TERMUX" = 1 ] && [ ! -d "$HOME/storage" ]; then
  step "Shared storage"
  echo "To read firmware from Downloads, run once and allow the permission prompt:"
  echo "  termux-setup-storage"
fi

step "Done"
echo "Try:  fwextract ~/storage/downloads/<firmware>.zip --list"
[ "$OPTIONAL_OK" = 1 ] && exit 0
exit 3
