#!/data/data/com.termux/files/usr/bin/bash
# usb-hotspot-watcher: when USB power is plugged in, turn on mobile data and the
# hotspot. Unplugging changes nothing, so both stay on.
#
# Needs the ADB self-connect from docs/adb-wireless.md (Termux cannot toggle
# data or the hotspot itself). Mobile data uses `svc data enable`, which is
# standard. There is no standard shell command for the hotspot, so it runs
# whatever you put in HOTSPOT_CMD (an adb shell command line). Find one with:
#   usb-hotspot-watcher.sh --probe
#
# Usage:
#   usb-hotspot-watcher.sh --probe     list tether/softap commands this phone has
#   usb-hotspot-watcher.sh --once      run the plug-in actions now and exit (test)
#   usb-hotspot-watcher.sh             watch forever
# Env: HOTSPOT_CMD='cmd ...'  ADB_SERIAL=host:port  INTERVAL=3
INTERVAL=${INTERVAL:-3}
ADB=(adb ${ADB_SERIAL:+-s "$ADB_SERIAL"})
log() { printf '%s %s\n' "$(date +%T)" "$*"; }
sh_() { "${ADB[@]}" shell "$@" 2>/dev/null | tr -d '\r'; }

hotspot_up() {  # Samsung's AP interface is swlan0; other builds use ap0/wlan1
  sh_ ip -o addr show | grep -Eq '(swlan0|ap0|wlan1) +inet '
}

usb_powered() {
  sh_ dumpsys battery | grep -q 'USB powered: true'
}

on_plug() {
  log "USB power connected"
  sh_ svc data enable
  if [ -z "$HOTSPOT_CMD" ]; then
    log "HOTSPOT_CMD not set; data enabled only. Run with --probe."
    return
  fi
  hotspot_up && { log "hotspot already on"; return; }
  # shellcheck disable=SC2086
  sh_ $HOTSPOT_CMD
  for _ in 1 2 3 4 5; do
    sleep 2
    hotspot_up && { log "hotspot on"; return; }
  done
  log "hotspot did not come up after: $HOTSPOT_CMD"
  command -v termux-notification >/dev/null &&
    termux-notification -t "usb-hotspot-watcher" -c "Hotspot did not start"
}

case "$1" in
  --probe)
    for svc in connectivity wifi tethering; do
      echo "== cmd $svc =="
      sh_ cmd "$svc" help | grep -iE 'tether|softap|hotspot' || echo "(nothing)"
    done
    echo "== wifi_ap / swlan0 interfaces =="
    sh_ ip -o link show | grep -E 'swlan0|ap0|wlan1' || echo "(none up)"
    exit ;;
  --once) on_plug; exit ;;
esac

"${ADB[@]}" devices | awk 'NR>1&&$2=="device"{f=1} END{exit !f}' ||
  { echo "No adb device. Connect first (docs/adb-wireless.md)."; exit 1; }
command -v termux-wake-lock >/dev/null && termux-wake-lock
log "watching (every ${INTERVAL}s)"
was=0
while :; do
  if usb_powered; then
    [ "$was" = 0 ] && on_plug
    was=1
  else
    [ "$was" = 1 ] && log "USB power removed (data and hotspot left on)"
    was=0
  fi
  sleep "$INTERVAL"
done
