#!/data/data/com.termux/files/usr/bin/bash
# One-shot setup for phone-mirror.py: installs deps, fetches the script, pairs,
# connects and starts the viewer. Safe to re-run; it skips steps already done.
#   curl -fsSL https://raw.githubusercontent.com/doomcrew328/claude-code-android/ccr-37a4fc87-g1tskx/examples/phone-mirror-setup.sh | bash
set -e
BRANCH=ccr-37a4fc87-g1tskx
RAW=https://raw.githubusercontent.com/doomcrew328/claude-code-android/$BRANCH/examples/phone-mirror.py
DEST="$HOME/phone-mirror.py"

[ "$PREFIX" = "/data/data/com.termux/files/usr" ] || { echo "Run this inside Termux on the viewing phone."; exit 1; }
# curl|bash leaves stdin as the script, so prompts must read the terminal.
ask() { printf '%s' "$1" > /dev/tty; read -r REPLY < /dev/tty; }

command -v adb >/dev/null && command -v python >/dev/null || pkg install -y android-tools python
curl -fsSL "$RAW" -o "$DEST"

if ! adb devices | awk 'NR>1 && $2=="device"{f=1} END{exit !f}'; then
  echo
  echo "On the OTHER phone: Settings > Developer options > Wireless debugging ON,"
  echo "then tap 'Pair device with pairing code'. Keep that dialog open."
  ask "Pairing IP:PORT (e.g. 192.168.1.50:37000): "; PAIR=$REPLY
  ask "6-digit pairing code: "; CODE=$REPLY
  adb pair "$PAIR" "$CODE"
  echo
  echo "Close the dialog. The Wireless debugging screen shows a different IP:PORT."
  ask "Connect IP:PORT: "; adb connect "$REPLY"
fi

echo
echo "Starting. Open http://127.0.0.1:8080 in this phone's browser."
exec python "$DEST"
