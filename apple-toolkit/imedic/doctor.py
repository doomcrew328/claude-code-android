"""Environment check: tells you honestly what THIS machine can and can't do."""
import os
import shutil

from . import core


def _has(cmd):
    return shutil.which(cmd) is not None


def run():
    core.h1("iMedic environment check")
    core.teach("This tells you what your current setup can do. iMedic works on "
               "a lot; the deepest USB work wants a Linux/Mac computer.")

    is_termux = "com.termux" in os.environ.get("PREFIX", "") or os.path.isdir(
        "/data/data/com.termux")
    is_root = hasattr(os, "geteuid") and os.geteuid() == 0

    print()
    if is_termux:
        core.info("Platform: Android / Termux (portable — good for on-the-go).")
    else:
        core.info("Platform: desktop-style OS (best for restoring/flashing).")

    # USB detection backends
    if _has("termux-usb"):
        core.good("termux-usb present — can detect iPhone USB mode over OTG.")
    elif is_termux:
        core.warn("termux-usb missing. Run:  pkg install termux-api  and "
                  "install the Termux:API app from F-Droid.")
    else:
        core.info("termux-usb: n/a (not Termux).")

    if _has("ideviceinfo"):
        core.good("libimobiledevice present — full 'ADB for iPhone' toolset.")
    else:
        core.warn("libimobiledevice not found. On Linux: "
                  "sudo apt install libimobiledevice-utils. It's the open-source "
                  "engine for real diagnostics + restore.")

    if _has("idevicerestore"):
        core.good("idevicerestore present — can flash signed firmware.")
    else:
        core.info("idevicerestore not found (comes with libimobiledevice / "
                  "can be built separately).")

    if _has("checkra1n") or _has("checkra1n.app") or _has("palera1n"):
        core.good("A checkm8 tool is present — deep rescue for A5–A11 devices.")
    else:
        core.info("No checkm8 tool (checkra1n/palera1n) found — only needed for "
                  "deep rescue on iPhone X and older.")

    # honest platform verdict
    print()
    if is_termux and not _has("ideviceinfo"):
        core.warn("Verdict: great as a PORTABLE brain — detect modes, run the "
                  "DFU coach, diagnose, and look up models/firmware right at the "
                  "junk pile. For the actual RESTORE of a dead phone, plug it "
                  "into a Linux/Mac computer running libimobiledevice.")
    elif _has("ideviceinfo"):
        core.good("Verdict: full workstation — you can detect, diagnose AND "
                  "restore from here.")
    if not is_root and is_termux:
        core.info("(No root: USB descriptor reads may be blocked on some phones. "
                  "The DFU coach + screen check always work as a fallback.)")
