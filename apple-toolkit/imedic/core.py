"""Shared helpers for iMedic: paths, data loading, and terminal UI."""
import json
import os
import sys

# .../apple-toolkit/imedic/core.py  ->  .../apple-toolkit
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(code):
    return code if _USE_COLOR else ""


BOLD = _c("\033[1m")
DIM = _c("\033[2m")
RESET = _c("\033[0m")
RED = _c("\033[31m")
GREEN = _c("\033[32m")
YELLOW = _c("\033[33m")
BLUE = _c("\033[34m")
CYAN = _c("\033[36m")


def load(name):
    """Load a JSON data file by base name (without .json)."""
    with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as fh:
        return json.load(fh)


def banner():
    print(f"""{CYAN}{BOLD}
   _ __  __          _ _
  (_)  \\/  | ___  __| (_) ___
  | | |\\/| |/ _ \\/ _` | |/ __|
  | | |  | |  __/ (_| | | (__
  |_|_|  |_|\\___|\\__,_|_|\\___|{RESET}
  {DIM}iPhone diagnostics, repair & rescue — that teaches as it goes{RESET}
""")


def h1(text):
    print(f"\n{BOLD}{CYAN}== {text} =={RESET}")


def teach(text):
    print(f"{DIM}{YELLOW}  why:{RESET}{DIM} {text}{RESET}")


def good(text):
    print(f"{GREEN}  ✔ {text}{RESET}")


def warn(text):
    print(f"{YELLOW}  ! {text}{RESET}")


def bad(text):
    print(f"{RED}  ✗ {text}{RESET}")


def info(text):
    print(f"  {text}")


def ask(prompt):
    """Yes/no prompt that tolerates y/n/yes/no and blank=no."""
    while True:
        try:
            raw = input(f"{BOLD}{prompt}{RESET} [y/n] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if raw in ("y", "yes"):
            return True
        if raw in ("n", "no", ""):
            return False
        print("  Please answer y or n.")
