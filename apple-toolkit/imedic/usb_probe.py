"""Tiny helper run *under* `termux-usb -e` (or with a raw fd).

termux-usb opens the USB device and hands us an already-open file
descriptor as argv[1]. On Linux/Android a usbdevfs node begins with the
18-byte USB device descriptor; idVendor lives at offset 8, idProduct at
offset 10 (little-endian). We read just those bytes — no libusb, no root.

Prints "VVVV:PPPP" (hex) on success, or "ERR: <reason>" on failure.
"""
import os
import struct
import sys


def main():
    if len(sys.argv) < 2:
        print("ERR: no fd argument")
        return 1
    try:
        fd = int(sys.argv[1])
    except ValueError:
        print("ERR: bad fd")
        return 1
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        desc = os.read(fd, 18)
        if len(desc) < 12:
            print("ERR: short descriptor")
            return 1
        id_vendor, id_product = struct.unpack_from("<HH", desc, 8)
        print(f"{id_vendor:04x}:{id_product:04x}")
        return 0
    except OSError as exc:
        print(f"ERR: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
