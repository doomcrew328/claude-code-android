"""iMedic entry point: interactive menu (great on a phone) + subcommands."""
import sys

from . import core, detect, diagnose, dfu, doctor, firmware, models, teach
from . import __version__

HELP = f"""{core.BOLD}iMedic{core.RESET} v{__version__} — iPhone diagnostics, repair & rescue

{core.BOLD}Usage:{core.RESET}
  imedic                     interactive menu (best on a phone)
  imedic doctor              what can this machine do?
  imedic detect              find a connected iPhone & its USB mode
  imedic diagnose [symptom]  guided fault-finding (teaches as it goes)
  imedic models              list every iPhone model
  imedic model <id|name>     details for one model (e.g. 'iPhone 7')
  imedic dfu <id|name>       DFU entry steps for that model
  imedic recovery <id|name>  Recovery entry steps for that model
  imedic firmware <id|name>  what iOS is signed + how to restore
  imedic teach [term]        plain-English explanations (dfu, 4013, …)
  imedic help                this help
"""

def _interactive():
    core.banner()
    while True:
        core.h1("Main menu")
        opts = [
            "Check what this machine can do (doctor)",
            "Detect a connected iPhone",
            "Diagnose a broken phone (guided)",
            "Look up a model + its DFU steps",
            "Check firmware & signing status",
            "Learn a term (glossary)",
            "Quit",
        ]
        for i, o in enumerate(opts, 1):
            print(f"  {core.BOLD}{i}.{core.RESET} {o}")
        try:
            choice = input(f"\n{core.BOLD}Pick:{core.RESET} ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nbye 👋")
            return
        if choice == "1":
            doctor.run()
        elif choice == "2":
            detect.run()
        elif choice == "3":
            diagnose.menu()
        elif choice == "4":
            q = input("  Which iPhone? (name or id): ").strip()
            if q:
                models.show(q)
                dfu.coach(q)
        elif choice == "5":
            q = input("  Which iPhone? (name or id): ").strip()
            if q:
                firmware.show(q)
        elif choice == "6":
            t = input("  Term (blank = list): ").strip()
            teach.show(t or None)
        elif choice in ("7", "q", "quit", "exit"):
            print("bye 👋")
            return
        else:
            core.warn("Pick 1–7.")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        _interactive()
        return 0

    cmd, rest = argv[0].lower(), argv[1:]
    arg = " ".join(rest).strip()

    if cmd in ("help", "-h", "--help"):
        print(HELP)
    elif cmd in ("version", "-v", "--version"):
        print(f"iMedic {__version__}")
    elif cmd == "doctor":
        doctor.run()
    elif cmd == "detect":
        detect.run()
    elif cmd == "diagnose":
        diagnose.run(arg) if arg else diagnose.menu()
    elif cmd == "models":
        models.list_all()
    elif cmd == "model":
        models.show(arg) if arg else models.list_all()
    elif cmd == "dfu":
        dfu.coach(arg) if arg else core.bad("Give a model, e.g. imedic dfu 'iPhone X'")
    elif cmd == "recovery":
        dfu.coach(arg, recovery=True) if arg else core.bad("Give a model.")
    elif cmd == "firmware":
        firmware.show(arg) if arg else core.bad("Give a model, e.g. imedic firmware 'iPhone 8'")
    elif cmd == "teach":
        teach.show(arg or None)
    else:
        core.bad(f"Unknown command '{cmd}'.")
        print(HELP)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
