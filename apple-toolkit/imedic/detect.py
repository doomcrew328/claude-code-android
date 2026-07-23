"""Detect a connected Apple device and identify its USB mode.

On Android/Termux this uses `termux-usb` over an OTG cable. No root
needed: termux-usb grants a per-device file descriptor after the user
taps 'OK' on the Android permission dialog, and usb_probe.py reads the
vendor/product IDs from it.

On a Linux desktop with libimobiledevice installed we also surface the
richer `ideviceinfo` path. Everything degrades gracefully: if a layer
isn't available we say so and keep going.
"""
import os
import shutil
import subprocess

from . import core

PROBE = os.path.join(core.ROOT, "imedic", "usb_probe.py")


def _run(cmd, timeout=25):
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return out.returncode, out.stdout.strip(), out.stderr.strip()
    except FileNotFoundError:
        return 127, "", "not found"
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"


def _mode_for(pid, modes):
    return modes["modes"].get(pid.lower())


def _identify(vid, pid):
    usb = core.load("usb_modes")
    core.info(f"USB device: {core.BOLD}{vid}:{pid}{core.RESET}")
    if vid.lower() != usb["vendor_id"]:
        core.warn(f"Vendor {vid} is not Apple (Apple = {usb['vendor_id']}). "
                  "This isn't an iPhone/iPad, or the read was off.")
        return
    core.good(f"Apple device confirmed (vendor {vid} = {usb['vendor_name']}).")
    mode = _mode_for(pid, usb)
    if not mode:
        core.warn(f"Apple device, but product id {pid} isn't in my table. "
                  "It's likely booted iOS or a mode I don't have mapped yet.")
        return
    label = core.GREEN if mode.get("good") else core.YELLOW
    print(f"\n  Mode: {label}{core.BOLD}{mode['label']}{core.RESET}")
    core.teach(mode["meaning"])
    if mode["mode"] in ("DFU", "RECOVERY", "DFU_WTF", "PONGO"):
        core.info("Next: a clean RESTORE from a computer can often revive it "
                  "(see: imedic firmware).")


def termux_scan():
    """Return True if we attempted a termux-usb scan (available)."""
    if shutil.which("termux-usb") is None:
        return False
    core.h1("Scanning USB over OTG (termux-usb)")
    core.teach("termux-usb lists USB devices your phone can see through the "
               "OTG cable, then asks Android for permission to read one.")
    rc, out, err = _run(["termux-usb", "-l"])
    if rc == 127:
        return False
    devices = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("/dev")]
    if not devices:
        core.warn("No USB devices seen. Check: OTG adapter seated? iPhone "
                  "plugged in? Try wiggling the cable and re-run.")
        return True
    for dev in devices:
        core.info(f"Found: {dev}  — approve the Android popup to read it…")
        rc, out, err = _run(
            ["termux-usb", "-r", "-e", f"python {PROBE}", dev]
        )
        line = (out or err).strip().splitlines()[-1] if (out or err) else ""
        if line.startswith("ERR") or not line or ":" not in line:
            core.warn(f"Couldn't read descriptor from {dev} ({line or 'no data'}). "
                      "Some phones block raw reads without root — use the DFU "
                      "coach + screen check to confirm the mode instead.")
            continue
        vid, pid = line.split(":", 1)
        _identify(vid, pid)
    return True


def libimobiledevice_probe():
    """If libimobiledevice is present (mostly desktop), pull real info."""
    if shutil.which("ideviceinfo") is None:
        return False
    core.h1("libimobiledevice detected — reading device info")
    rc, out, err = _run(["ideviceinfo", "-s"])  # -s = simple/no pairing
    if rc != 0 or not out:
        core.warn("libimobiledevice is installed but no paired/booted device "
                  "answered. That's normal if the phone is in DFU/Recovery.")
        return True
    wanted = ("ProductType", "ProductVersion", "DeviceName",
              "SerialNumber", "ActivationState", "BatteryCurrentCapacity")
    for line in out.splitlines():
        if any(line.startswith(k) for k in wanted):
            core.info(line)
    return True


def run():
    core.h1("Device detection")
    did_termux = termux_scan()
    did_imd = libimobiledevice_probe()
    if not did_termux and not did_imd:
        core.warn("No detection backend available on this machine.")
        core.info("On your Android phone:  pkg install termux-api  "
                  "and install the Termux:API app, then plug the iPhone in "
                  "with an OTG cable.")
        core.info("On a Linux computer:  install libimobiledevice "
                  "(sudo apt install libimobiledevice-utils).")
        core.teach("Detection is a bonus layer. Even with none of it, iMedic's "
                   "DFU coach, model database and diagnostics all still work.")
