"""DFU and Recovery entry coach, per model family."""
from . import core
from . import models as models_mod


def _family_for(query):
    m = models_mod._find(query)
    if not m or isinstance(m, list):
        return None, None
    return m, m["family"]


def coach(query, recovery=False):
    m, family = _family_for(query)
    data = core.load("dfu")
    if family is None:
        core.warn(f"Couldn't pin down a single model for '{query}'. Falling back "
                  "to showing all three button families so you can pick.")
        _show_all(data, recovery)
        return
    kind = "recovery" if recovery else "dfu"
    core.h1(f"{'Recovery' if recovery else 'DFU'} mode — {m['name']} ({m['id']})")
    if recovery:
        steps = data["recovery"][family]
        note = "Recovery shows the 'connect to computer' cable graphic."
    else:
        entry = data["dfu"][family]
        steps = entry["steps"]
        note = entry["note"]
    core.teach(note)
    core.teach("DFU = a totally BLACK screen. If the Apple logo appears, you "
               "held too long — no harm done, just start over.")
    print()
    for i, step in enumerate(steps, 1):
        print(f"  {core.BOLD}{i}.{core.RESET} {step}")
    print()
    core.info(f"After it's in mode, run:  {core.BOLD}imedic detect{core.RESET}  "
              "to confirm, then  imedic firmware  to restore.")


def _show_all(data, recovery):
    kind = "recovery" if recovery else "dfu"
    labels = {"home": "Home-button phones (iPhone 6s & older, SE 1st gen)",
              "home7": "iPhone 7 / 7 Plus",
              "faceid": "iPhone 8 / X and newer (Face ID, 8/8+, SE 2/3)"}
    for fam, label in labels.items():
        core.h1(label)
        steps = data[kind][fam] if recovery else data[kind][fam]["steps"]
        for i, step in enumerate(steps, 1):
            print(f"  {i}. {step}")
