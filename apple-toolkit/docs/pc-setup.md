# Setting up your PC as the iPhone workbench

Your Android phone is the pocket brain (detect, diagnose, coach, look things up).
Your **PC is where a dead iPhone actually gets brought back to life** — the
restore/flash step. This guide gets that half working. Pick your OS.

> The golden rule for every restore: **use a short, good-quality USB cable
> plugged directly into a rear USB port** (not a hub, not a front-case port).
> Most "restore failed" errors are really cable/port errors.

---

## Windows (probably what you're on)

Everything you need here is **free**. Use Apple's own tool first — it's the
zero-cost, no-third-party path — and only add 3uTools if you want the extra
niceties.

### The free primary path: iTunes (Apple's own)

1. **Install iTunes from apple.com** — the **direct download**, *not* the
   Microsoft Store version. The Store build hides the USB device driver you
   need; the apple.com installer includes it. This is what lets Windows see an
   iPhone in Recovery/DFU at all, so you want it either way.
2. **Reviving a bricked phone:**
   - On your S21, run `imedic dfu <model>` for the button steps and
     `imedic firmware <model>` to see what iOS is signed + grab the `.ipsw`
     from ipsw.me.
   - Put the phone in Recovery or DFU and plug it into the PC.
   - In iTunes, hold **Shift** and click **Restore** to point it at the `.ipsw`
     you downloaded. (Plain "Restore" without Shift auto-downloads the latest
     signed build for you — also fine.)

That's the whole job for the vast majority of software boot loops. Free, no
third party, nothing to untick.

### Optional nicer UI: 3uTools

**3uTools** (`3u.com`) is also free — a friendlier all-in-one that shows battery
health, reads the phone's details, and gives you a restore progress bar. It's
the closest thing to a "SamFW experience" on the Apple side. Caveats worth
knowing:

- It's **closed-source and ad-supported** (bundled recommendations; watch the
  installer and untick extras). Fine for practice phones; **don't sign into your
  real Apple ID through it.**
- To flash: **Flash & JB** → pick the signed firmware → **Flash** (leave "retain
  data" off for a clean, reliable erase-flash on a practice phone).

Treat it as a convenience layer *on top of* iTunes' driver, not a replacement.

Windows can't run the deep `checkm8` rescue well — for that you want Linux/Mac
(below). But for 90% of software boot loops, free iTunes on Windows is all you
need.

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
