# Phone Mirror: view one phone on another

Show a second phone's screen (and tap it) from the first phone, for example a Galaxy S25 Ultra on a Galaxy S21 FE.

## Why not just plug them together

A phone's USB-C port cannot take video in, and a phone cannot be a Miracast/Smart View receiver. A cable alone never mirrors. This uses ADB over Wi-Fi instead, with Termux on the phone that does the viewing. See [adb-wireless.md](adb-wireless.md) for the pairing background.

Limits: a few frames per second (screenshot polling). Fine for menus, apps and files; not for video or games. Both phones must be on the same Wi-Fi (a hotspot from either phone works).

## Setup

On the viewing phone (Termux):

```sh
pkg install android-tools python
cp examples/phone-mirror.py ~/
```

On the phone being shown: Settings > Developer options > Wireless debugging on, then **Pair device with pairing code**. Note the IP:port and 6-digit code.

```sh
python ~/phone-mirror.py --pair 192.168.1.50:37000 123456
```

Then close the pairing dialog; the main Wireless debugging screen shows a different IP:port. Use that:

```sh
python ~/phone-mirror.py --connect 192.168.1.50:41234
```

Open `http://127.0.0.1:8080` in the viewing phone's browser. Tap the picture to tap the other phone; the buttons send Back, Home, Recents and Power.

Next sessions only need `--connect` (the port changes each time wireless debugging is toggled). Add `--wait` to keep waiting until a device appears.

## Security

Anyone who can reach the page can control the other phone. The server binds to 127.0.0.1 only, so only this phone can. Do not change that without adding authentication.
