# Setting up your PC as the iPhone workbench

Your Android phone is the pocket brain (detect, diagnose, coach, look things up).
Your **PC is where a dead iPhone actually gets brought back to life** — the
restore/flash step. This guide gets that half working. Pick your OS.

> The golden rule for every restore: **use a short, good-quality USB cable
> plugged directly into a rear USB port** (not a hub, not a front-case port).
> Most "restore failed" errors are really cable/port errors.

---

## Windows (probably what you're on)

Windows doesn't run libimobiledevice cleanly, so use the tools that Just Work:

1. **Install Apple's driver.** Get **iTunes from apple.com** (the direct
   download, *not* the Microsoft Store version — the Store one hides the device
   driver you need). Installing it gives Windows the USB driver that lets it see
   an iPhone in Recovery/DFU.
2. **Install 3uTools** (`3u.com`) — a free all-in-one that reads the phone,
   shows battery health, and does restores with a friendly progress bar. This is
   the closest thing to a "SamFW experience" on the Apple side.
3. **Reviving a bricked phone:**
   - On your S21, run `imedic dfu <model>` for the button steps and
     `imedic firmware <model>` to see what iOS is currently signed.
   - Put the phone in Recovery or DFU, plug into the PC.
   - In 3uTools → **Flash & JB** → pick the signed firmware → **Flash**
     (tick "retain data" only if you're trying to save data; for a practice
     phone, a clean erase-flash is the reliable choice).
   - Or in iTunes/Finder: hold **Shift** and click **Restore** to point it at an
     `.ipsw` you downloaded from ipsw.me.

Windows can't run the deep `checkm8` rescue well — for that you want Linux/Mac
(below). For 90% of software boot loops, 3uTools on Windows is all you need.

---

## Linux (the power path — best for deep rescue)

This is the open-source "ADB for iPhone" toolchain, and the only place the deep
checkm8 rescue really shines.

```bash
# Debian / Ubuntu / Mint
sudo apt update
sudo apt install libimobiledevice-utils usbmuxd ideviceinstaller
# idevicerestore isn't always packaged; if 'idevicerestore' is missing, build it
# from github.com/libimobiledevice/idevicerestore (README has the steps).

# check it sees a normally-booted phone:
ideviceinfo -s
```

Reviving a phone:

```bash
# 1. put it in DFU/Recovery (imedic dfu <model> on your S21 for the steps)
# 2. restore to the signed firmware you downloaded:
idevicerestore -e /path/to/firmware.ipsw     # -e = erase (clean, reliable)
```

**Deep rescue for iPhone X and older (checkm8):** install **checkra1n**
(checkra.in) or **palera1n** — these use the unpatchable BootROM exploit to get
under iOS even on a phone that won't otherwise cooperate. Only works on A5–A11
(run `imedic model <name>` — it tells you if the phone is checkm8-eligible).

---

## macOS

- **Finder** (macOS Catalina+) or **iTunes** (older) handles Recovery/DFU
  restores natively — hold **Option** and click **Restore** to choose an `.ipsw`.
- For the command-line toolchain: `brew install libimobiledevice ideviceinstaller`.
- checkra1n has a native Mac app for the deep A5–A11 rescue.

---

## The workflow, end to end

1. **S21:** `imedic diagnose` → figure out what's actually wrong.
2. **S21:** `imedic dfu <model>` → get the phone talking; `imedic detect` if you
   have the OTG cable handy to confirm the mode.
3. **S21:** `imedic firmware <model>` → note the signed iOS + grab the `.ipsw`.
4. **PC:** put the phone in DFU/Recovery, restore with the tool for your OS above.
5. Boots clean → it was software (a real win). Fails at the same % every time →
   run `imedic teach <error#>`; you're likely looking at a hardware/board fault.

You never have to memorize any of this — the phone in your hand tells you the
next step each time.
