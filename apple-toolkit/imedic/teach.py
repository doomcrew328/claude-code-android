"""The teaching glossary: 'imedic teach <term>'."""
from . import core


def show(term=None):
    data = core.load("glossary")["terms"]
    if not term:
        core.h1("Things I can explain")
        core.teach("Run:  imedic teach <term>   (e.g. imedic teach dfu, "
                   "imedic teach 4013)")
        keys = sorted(data.keys())
        # print in columns-ish
        line = "  "
        for k in keys:
            if len(line) + len(k) + 2 > 70:
                print(line)
                line = "  "
            line += k + "  "
        print(line)
        return
    key = term.strip().lower()
    if key in data:
        core.h1(key)
        core.info(data[key])
        return
    # partial match
    hits = [k for k in data if key in k]
    if len(hits) == 1:
        core.h1(hits[0])
        core.info(data[hits[0]])
    elif hits:
        core.warn(f"'{term}' matched several: {', '.join(hits)}")
    else:
        core.bad(f"I don't have '{term}' yet. Run 'imedic teach' for the list. "
                 "You can add it to data/glossary.json — it's yours to grow.")
