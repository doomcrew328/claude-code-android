#!/usr/bin/env python3
"""phone-mirror: view and tap another Android phone from this phone's browser.

Run in Termux on the viewing phone (e.g. a Galaxy S21 FE). It pulls screenshots
from the other phone (e.g. a Galaxy S25 Ultra) over ADB and serves them as a
web page on localhost. Open http://127.0.0.1:8080 in the viewing phone's browser.

Why not a cable: a phone's USB-C port cannot take video in, so plugging two
phones together never mirrors. ADB over Wi-Fi (wireless debugging) works.

Setup (see docs/phone-mirror.md): pkg install android-tools python
Usage:
  python phone-mirror.py --pair 192.168.1.50:37000 123456    # one time
  python phone-mirror.py --connect 192.168.1.50:41234        # every session
  python phone-mirror.py                                      # already connected

Stdlib only. Frame rate is a few fps (screencap polling); it is a viewer for
menus, apps and files, not for video or games.
"""
import argparse
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PAGE = b"""<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>phone-mirror</title>
<style>
html,body{margin:0;height:100%;background:#000;color:#ccc;font:14px sans-serif}
#bar{display:flex;gap:6px;padding:6px;background:#111}
#bar button{flex:1;padding:10px;font-size:16px;background:#222;color:#fff;border:0;border-radius:6px}
#v{display:block;margin:0 auto;max-width:100%;max-height:calc(100% - 52px);touch-action:manipulation}
#s{position:fixed;left:6px;right:6px;bottom:4px;font-size:12px;opacity:.8;word-break:break-word}
</style>
<div id=bar>
<button onclick="key(4)">Back</button><button onclick="key(3)">Home</button>
<button onclick="key(187)">Recents</button><button onclick="key(26)">Power</button>
</div>
<img id=v alt="waiting for first frame"><div id=s></div>
<script>
const v=document.getElementById('v'),s=document.getElementById('s');
let n=0,t0=Date.now();
function next(){v.src='/frame?'+(n++)}
v.onload=()=>{const fps=n*1000/(Date.now()-t0);s.textContent=fps.toFixed(1)+' fps';next()};
v.onerror=()=>{fetch('/frame?err').then(r=>r.text()).then(t=>{s.textContent='NO FRAME: '+t.slice(0,300)}).catch(()=>{s.textContent='NO FRAME: server unreachable'});setTimeout(next,2000)};
v.onclick=e=>{const r=v.getBoundingClientRect();
 const x=Math.round((e.clientX-r.left)/r.width*v.naturalWidth);
 const y=Math.round((e.clientY-r.top)/r.height*v.naturalHeight);
 fetch('/tap?x='+x+'&y='+y)};
function key(c){fetch('/key?code='+c)}
next();
</script>"""


class Phone:
    def __init__(self, serial):
        self.base = ["adb"] + (["-s", serial] if serial else [])
        self.lock = threading.Lock()
        self.frame, self.frame_t = None, 0.0

    def run(self, *args, timeout=15):
        return subprocess.run(self.base + list(args), capture_output=True, timeout=timeout)

    def screenshot(self):
        # One adb call at a time; clients arriving within 80 ms share a frame.
        with self.lock:
            if self.frame and time.time() - self.frame_t < 0.08:
                return self.frame
            out = self.run("exec-out", "screencap", "-p")
            if out.returncode != 0 or not out.stdout.startswith(b"\x89PNG"):
                raise RuntimeError(out.stderr.decode(errors="replace").strip() or "bad frame")
            self.frame, self.frame_t = out.stdout, time.time()
            return self.frame

    def tap(self, x, y):
        self.run("shell", "input", "tap", str(x), str(y))

    def key(self, code):
        self.run("shell", "input", "keyevent", str(code))


def devices():
    out = subprocess.run(["adb", "devices"], capture_output=True, text=True, timeout=15).stdout
    return [l.split()[0] for l in out.splitlines()[1:] if l.strip().endswith("\tdevice") or l.endswith(" device")]


def make_handler(phone):
    class H(BaseHTTPRequestHandler):
        def reply(self, code, body=b"", ctype="text/plain"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            try:
                if u.path == "/":
                    self.reply(200, PAGE, "text/html")
                elif u.path == "/frame":
                    self.reply(200, phone.screenshot(), "image/png")
                elif u.path == "/tap":
                    phone.tap(int(q["x"][0]), int(q["y"][0]))
                    self.reply(204)
                elif u.path == "/key":
                    phone.key(int(q["code"][0]))
                    self.reply(204)
                else:
                    self.reply(404)
            except (KeyError, ValueError):
                self.reply(400)
            except (RuntimeError, subprocess.TimeoutExpired) as e:
                self.reply(503, str(e).encode())
            except BrokenPipeError:
                pass

        def log_message(self, *a):
            pass

    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pair", nargs=2, metavar=("HOST:PORT", "CODE"), help="pair once using the code from the other phone")
    ap.add_argument("--connect", metavar="HOST:PORT", help="adb connect to the other phone")
    ap.add_argument("--serial", help="adb serial to mirror (default: the only connected device)")
    ap.add_argument("--port", type=int, default=8080, help="local web port (default 8080, must be 1024+)")
    ap.add_argument("--wait", action="store_true", help="wait until a device is connected instead of exiting")
    a = ap.parse_args()

    if a.pair:
        r = subprocess.run(["adb", "pair", a.pair[0], a.pair[1]])
        if r.returncode:
            sys.exit("pairing failed; the code and port expire when the dialog closes")
    if a.connect:
        subprocess.run(["adb", "connect", a.connect])

    serial = a.serial
    while not serial:
        devs = devices()
        if len(devs) == 1:
            serial = devs[0]
        elif len(devs) > 1:
            sys.exit("several devices connected, pick one with --serial: " + ", ".join(devs))
        elif a.wait:
            print("waiting for a device...", flush=True)
            time.sleep(3)
        else:
            sys.exit("no device found. Run with --connect HOST:PORT (see docs/phone-mirror.md)")

    phone = Phone(serial)
    print(f"mirroring {serial}\nopen http://127.0.0.1:{a.port} in your browser (Ctrl+C to stop)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(phone)).serve_forever()


if __name__ == "__main__":
    main()
