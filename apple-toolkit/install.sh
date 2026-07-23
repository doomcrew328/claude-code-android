#!/usr/bin/env bash
# iMedic installer. Safe to re-run. Works in Termux (Android) and on Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
GREEN=$'\033[32m'; YEL=$'\033[33m'; BOLD=$'\033[1m'; RST=$'\033[0m'

say()  { printf '%s%s%s\n' "$GREEN" "$1" "$RST"; }
warn() { printf '%s%s%s\n' "$YEL" "$1" "$RST"; }

echo "${BOLD}Installing iMedic…${RST}"

# 1. Python check
if ! command -v python3 >/dev/null 2>&1; then
  warn "python3 not found."
  if command -v pkg >/dev/null 2>&1; then
    echo "  Run: pkg install python"
  else
    echo "  Install Python 3 for your OS, then re-run."
  fi
  exit 1
fi
say "✔ python3: $(python3 --version)"

# 2. Make launcher executable
chmod +x "$ROOT/bin/imedic"
say "✔ launcher ready: $ROOT/bin/imedic"

# 3. Optional USB detection deps (Termux)
if [ -d /data/data/com.termux ] || printf '%s' "${PREFIX:-}" | grep -q com.termux; then
  echo "${BOLD}Termux detected.${RST}"
  if ! command -v termux-usb >/dev/null 2>&1; then
    warn "For iPhone USB detection over OTG, install the Termux:API app (F-Droid)"
    warn "and run:  pkg install termux-api"
  else
    say "✔ termux-usb present"
  fi
fi

# 4. Put 'imedic' on PATH via a symlink into a bin dir we can write to
LINK_TARGET=""
for d in "$HOME/.local/bin" "${PREFIX:-/usr/local}/bin" "/usr/local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then LINK_TARGET="$d/imedic"; break; fi
done
if [ -z "$LINK_TARGET" ] && mkdir -p "$HOME/.local/bin" 2>/dev/null; then
  LINK_TARGET="$HOME/.local/bin/imedic"
fi
if [ -n "$LINK_TARGET" ]; then
  ln -sf "$ROOT/bin/imedic" "$LINK_TARGET"
  say "✔ linked: $LINK_TARGET"
  case ":$PATH:" in
    *":$(dirname "$LINK_TARGET"):"*) : ;;
    *) warn "Add this to your shell rc:  export PATH=\"$(dirname "$LINK_TARGET"):\$PATH\"" ;;
  esac
else
  warn "Couldn't auto-link. Run it directly with:  $ROOT/bin/imedic"
fi

echo
say "Done. Try:  imedic doctor"
echo "Then:      imedic   (interactive menu)"
