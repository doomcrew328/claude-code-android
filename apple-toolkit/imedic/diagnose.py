"""Interactive guided diagnostics — walks the decision trees in faults.json."""
from . import core


def _conclude(c):
    core.h1(c["title"])
    core.info(c["body"])


def menu():
    data = core.load("faults")
    flows = data["flows"]
    concls = data["conclusions"]
    core.h1("Guided diagnostics")
    core.teach("Pick the main symptom. I'll ask one thing at a time and explain "
               "why each check matters. Answer from what you actually observe.")
    keys = list(flows.keys())
    for i, k in enumerate(keys, 1):
        print(f"  {core.BOLD}{i}.{core.RESET} {flows[k]['title']}")
    print(f"  {core.BOLD}0.{core.RESET} cancel")
    try:
        raw = input(f"\n{core.BOLD}Pick a number:{core.RESET} ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return
    if not raw.isdigit() or int(raw) == 0 or int(raw) > len(keys):
        core.info("Cancelled.")
        return
    run(keys[int(raw) - 1])


def run(flow_key):
    data = core.load("faults")
    flows = data["flows"]
    concls = data["conclusions"]
    if flow_key not in flows:
        core.bad(f"No such symptom '{flow_key}'. Options: {', '.join(flows)}")
        return
    flow = flows[flow_key]
    # allow one flow to hand off to another (e.g. boot-loop -> no-power)
    core.h1(flow["title"])
    _walk_with_handoff(flow_key, flows, concls)


def _walk_with_handoff(flow_key, flows, concls, depth=0):
    if depth > 4:
        core.warn("Too many hand-offs — stopping.")
        return
    flow = flows[flow_key]
    steps = flow["steps"]
    key = flow["start"]
    seen = set()
    while True:
        if key in concls:
            _conclude(concls[key])
            return
        if key in flows:  # handoff to another symptom tree
            core.info(f"\n→ This turns into the '{flows[key]['title']}' check:")
            _walk_with_handoff(key, flows, concls, depth + 1)
            return
        step = steps.get(key)
        if step is None:
            core.warn(f"(dead-end key '{key}')")
            return
        if key in seen:
            core.warn("Loop guard tripped — stopping.")
            return
        seen.add(key)
        core.info("")
        core.teach(step["teach"])
        answer = core.ask(step["ask"])
        if answer is None:
            core.info("\n(Stopped.)")
            return
        key = step["yes"] if answer else step["no"]
