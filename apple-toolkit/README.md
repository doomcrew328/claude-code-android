# iMedic

**An iPhone diagnostics, repair & rescue companion — that teaches you as it goes.**

Think of it as your pocket brain for working on broken iPhones: it identifies
any model, detects what mode a connected phone is in (even a "dead" one),
coaches you through DFU/Recovery, walks you through fault-finding, and tells you
what firmware Apple will actually let you restore. It runs right on your Android
phone in Termux, so it's with you at the junk pile.

It is built for **hands-on personal practice on your own devices** — the kind of
free/broken iPhones that turn up on Marketplace. It is not a redistribution
product and it contains no illegal "unlock" tricks (there aren't any real ones —
see the honesty section).

---

## Why this isn't just "SamFW for iPhone"

SamFW works because Samsung lets you download and flash any firmware freely.
**Apple does not.** Two hard walls exist on iPhones that have no Samsung
equivalent, and iMedic teaches you to work *with* them instead of pretending
they aren't there:

1. **The signing wall.** Every restore is approved live by Apple's server and
   only for the *current* iOS. You can revive a bricked phone, but you can't
   freely downgrade. (`imedic firmware <model>` shows what's signed right now.)
2. **Activation Lock.** A phone tied to someone's Apple ID can't be legitimately
   unlocked without that account. There is no real bypass — anything claiming
   otherwise is a scam. Such a phone is a **parts/practice unit only**.

Everything else — the "ADB for iPhone" toolchain — *does* have a great
open-source answer: **libimobiledevice** + **idevicerestore**, which iMedic
wraps and points you to.

---

## What it does

| Command | What it gives you |
|---|---|
| `imedic` | Interactive menu (best on a phone) |
| `imedic doctor` | Honest read on what *your* setup can and can't do |
| `imedic detect` | Finds a connected iPhone over OTG and names its USB mode (DFU / Recovery / Normal) — works on a black-screen "dead" phone |
| `imedic diagnose` | Guided, teach-as-you-go fault-finding (no power, won't charge, boot loop, disabled) |
| `imedic models` | Every iPhone model, chip, and checkm8 eligibility |
| `imedic model <id\|name>` | Details for one model |
| `imedic dfu <id\|name>` | Exact DFU button steps for that model |
| `imedic recovery <id\|name>` | Recovery-mode steps |
| `imedic firmware <id\|name>` | What iOS is currently signed + how to restore |
| `imedic teach <term>` | Plain-English glossary (`dfu`, `checkm8`, `4013`, …) |

---

## Install

**On your Android phone (Termux):**

```bash
# from the repo root
cd apple-toolkit
bash install.sh
# for live iPhone-over-OTG detection, also:
pkg install termux-api      # and install the Termux:API app from F-Droid
```

Then just run `imedic`.

**On a Linux/Mac computer (for the actual restoring/flashing):**

```bash
cd apple-toolkit && bash install.sh
# then the real engine:
sudo apt install libimobiledevice-utils   # Debian/Ubuntu
# (idevicerestore may need building from source on some distros)
```

Only dependency for the core is **Python 3**. Detection and restoring use extra
tools that iMedic detects and degrades around — nothing crashes if they're
missing.

---

## The honest workflow for your first repair

1. **Grab a free checkm8-eligible phone** (iPhone X or older — `imedic models`
   shows which). They're the cheapest to find, the safest to learn on, and the
   only ones with a deep rescue path.
2. **`imedic doctor`** — see what your gear can do.
3. **`imedic diagnose`** — figure out what's actually wrong before opening
   anything. Most "dead" marketplace phones are a dead battery, a filthy charge
   port, or a software boot loop — all beginner-fixable.
4. **`imedic dfu <model>`** then **`imedic detect`** — confirm the phone talks.
5. **`imedic firmware <model>`** — restore it to the signed iOS (fixes the whole
   software-boot-loop category, wipes it clean).
6. Only *then* reach for a screwdriver — battery and charge-port swaps are the
   ideal "beyond a screen" first repairs; charging-IC / no-power work is
   microsoldering and a later goal.

---

## A note on where the heavy lifting happens

Your S25 Ultra is a fantastic **portable brain** — detect modes, coach DFU,
diagnose, look up models and signing status, right at the pile. But the actual
**restore of a dead phone is safest from a Linux/Mac computer** running
libimobiledevice. Doing a full flash over Android OTG is flaky and a
half-written restore makes a worse brick. iMedic is built to run in both places
and tells you (`imedic doctor`) which role the machine you're on should play.

---

## Make it yours

Everything iMedic "knows" lives in editable JSON in `data/`:

- `models.json` — add models, correct chips, tweak notes
- `dfu.json` — button sequences
- `faults.json` — the diagnostic decision trees
- `glossary.json` — teaching terms and error codes

It's your tool. When you learn something new on a repair, add it — the app grows
with you.
