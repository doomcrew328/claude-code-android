"""Firmware + signing helper.

The hardest truth about iPhones vs. Samsung/SamFW lives here: Apple must
sign every restore live, and only signs the CURRENT iOS. So the useful
question isn't "where's the firmware" — it's "what is Apple still signing
for this exact model right now". When online, we ask the community API at
ipsw.me for that answer. Offline, we still explain the rules and the
restore command.
"""
import json
import urllib.error
import urllib.request

from . import core
from . import models as models_mod

API = "https://api.ipsw.me/v4/device/{ident}?type=ipsw"


def _fetch(ident):
    url = API.format(ident=ident)
    req = urllib.request.Request(url, headers={"User-Agent": "iMedic"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def show(query):
    m = models_mod._find(query)
    if not m or isinstance(m, list):
        core.bad(f"Give me one exact model. '{query}' didn't resolve. "
                 "Try: imedic models")
        return
    ident = m["id"]
    core.h1(f"Firmware & signing — {m['name']} ({ident})")
    core.teach("Apple signs restores in real time and only signs the newest "
               "iOS (briefly the one before). You CANNOT downgrade the way "
               "SamFW flashes any old Samsung build. Whatever's 'signed' below "
               "is what you can legally restore this phone to today.")

    core.info("\nAsking ipsw.me what's currently signed…")
    try:
        data = _fetch(ident)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        core.warn(f"Couldn't reach ipsw.me ({exc}). No internet? "
                  "The rules above still hold — try again when online.")
        _restore_howto(ident)
        return

    firmwares = data.get("firmwares", [])
    signed = [f for f in firmwares if f.get("signed")]
    if signed:
        core.good(f"Currently SIGNED (restorable) for {m['name']}:")
        for f in signed:
            size_gb = f.get("filesize", 0) / 1e9
            print(f"    iOS {f.get('version','?'):<10} build {f.get('buildid','?'):<10} "
                  f"{size_gb:0.2f} GB")
            core.info(f"    IPSW: {f.get('url','?')}")
    else:
        core.warn("Nothing reported as signed right now (or the API changed "
                  "shape). Check ipsw.me in a browser for this model.")
        latest = firmwares[0] if firmwares else None
        if latest:
            core.info(f"    Newest known build: iOS {latest.get('version')} "
                      f"({latest.get('buildid')})")
    _restore_howto(ident)


def _restore_howto(ident):
    core.h1("How to actually restore it")
    core.info("1. Put the phone in DFU or Recovery:  imedic dfu " + ident)
    core.info("2. Confirm the mode:  imedic detect")
    core.info("3. Restore with the open-source flasher (Linux/Mac):")
    print(f"     {core.BOLD}idevicerestore -e <firmware.ipsw>{core.RESET}   "
          f"{core.DIM}# -e erases; drop -e to keep data if possible{core.RESET}")
    core.info("   …or on any OS, drag the IPSW into Finder/iTunes while holding "
              "the restore option.")
    core.teach("idevicerestore is part of libimobiledevice — the open-source "
               "toolchain. It talks to Apple's signing server for you; if the "
               "build isn't signed anymore, Apple refuses and it can't proceed. "
               "That refusal is Apple's, not a bug in the tool.")
