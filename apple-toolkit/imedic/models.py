"""iPhone model database lookups."""
from . import core


def _all():
    return core.load("models")


def _find(query):
    db = _all()
    q = query.strip().lower()
    for m in db["models"]:
        if m["id"].lower() == q:
            return m
    # exact marketing-name match wins over substring (so 'iPhone X' != 'iPhone XS')
    exact = [m for m in db["models"] if m["name"].lower() == q]
    if exact:
        return exact[0]
    # fuzzy: match on marketing name substring
    hits = [m for m in db["models"] if q in m["name"].lower()]
    return hits[0] if len(hits) == 1 else hits


def list_all():
    db = _all()
    core.h1(f"iPhone model database ({len(db['models'])} models)")
    core.teach("Apple phones report a 'ProductType' like iPhone10,3. That id — "
               "not the marketing name — is what tools key off of.")
    for m in db["models"]:
        flag = f"{core.GREEN}checkm8{core.RESET}" if m["checkm8"] else f"{core.DIM}no checkm8{core.RESET}"
        print(f"  {core.BOLD}{m['id']:<12}{core.RESET} {m['name']:<22} "
              f"{m['chip']:<9} {m['year']}  {flag}")


def show(query):
    m = _find(query)
    if not m:
        core.bad(f"No model matched '{query}'. Try: imedic models  (to list all).")
        return
    if isinstance(m, list):
        core.warn(f"'{query}' matched several — be more specific:")
        for x in m:
            core.info(f"{x['id']}  {x['name']}")
        return
    db = _all()
    core.h1(f"{m['name']}  ({m['id']})")
    core.info(f"Chip:  {m['chip']}")
    core.info(f"Year:  {m['year']}")
    fam = db["families"].get(m["family"], m["family"])
    core.info(f"Button family:  {fam}")
    if m["checkm8"]:
        core.good("checkm8-eligible — the unpatchable BootROM exploit works on "
                  "this. Deepest possible access to a dead unit. Best kind of "
                  "phone to learn rescue on.")
    else:
        core.warn("Not checkm8-eligible (A12 or newer). Rescue is limited to "
                  "DFU/Recovery restore to Apple-signed firmware only.")
    core.info("")
    core.info(f"See DFU steps:  {core.BOLD}imedic dfu {m['id']}{core.RESET}")
