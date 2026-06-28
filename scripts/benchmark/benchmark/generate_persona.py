"""Parametric persona generator — replaces the spike branch's seven build_*.py.

A persona is a base template (facts + sessions + eval_questions) optionally
inflated with N "noise" sessions of generic chatter, so a single canonical
template can drive runs of varying corpus sizes (smaller = quick smoke test,
larger = stress test recall).

Usage:
  python -m benchmark.generate_persona \
      --base personas/jordan_rivera.json \
      --noise-sessions 50 \
      --seed 42 \
      --out personas/jordan_rivera_50.json
"""

from __future__ import annotations

import argparse
import copy
import json
import random
import sys
from pathlib import Path
from typing import Any, Dict, List

from .schema import validate_persona

# A small library of plausible-but-uninformative messages. They should be
# semantically distant from any persona fact so they reliably act as noise.
_NOISE_TEMPLATES: List[str] = [
    "Watched a documentary about deep-sea hydrothermal vents last night.",
    "Saw the new ramen place got a long line out the door again today.",
    "Restocked on coffee beans this morning — switched to a different roast.",
    "Took the long way home through the park, the trees are turning.",
    "Tried a new sourdough recipe over the weekend; the crumb wasn't bad.",
    "Got rained on walking back from the grocery store.",
    "The dog next door barked at the mail carrier for ten straight minutes.",
    "Watched a rerun of an old sci-fi movie — still holds up.",
    "Tested a new keyboard layout, going back to the old one tomorrow.",
    "Finally cleared the inbox down to triple digits.",
    "Heard a song on the radio I hadn't thought of in years.",
    "The traffic light at 4th and Main has been broken all week.",
    "Skipped the gym, went for a walk along the river instead.",
    "Tried a new tea, oolong, decent but not a daily driver.",
    "Watched birds at the feeder for half an hour while drinking coffee.",
    "Couldn't sleep, ended up reading until 2am.",
    "Cooked the same pasta dish I've made a hundred times.",
    "Saw an old colleague at the bookstore, caught up briefly.",
    "Spent the afternoon decluttering one corner of the apartment.",
    "Caught the last twenty minutes of a soccer match on TV.",
]


def generate(
    base: Dict[str, Any],
    *,
    noise_sessions: int = 0,
    messages_per_noise_session: int = 3,
    seed: int = 0,
) -> Dict[str, Any]:
    """Return a new persona dict with ``noise_sessions`` extra sessions injected.

    Deterministic for a fixed ``seed`` so a run is reproducible. The original
    base is not mutated.
    """
    persona = copy.deepcopy(base)
    if noise_sessions <= 0:
        return persona

    rng = random.Random(seed)
    existing_ids = {s["id"] for s in persona["sessions"]}
    next_idx = 1
    for _ in range(noise_sessions):
        while f"noise_{next_idx}" in existing_ids:
            next_idx += 1
        sid = f"noise_{next_idx}"
        existing_ids.add(sid)
        next_idx += 1
        msgs = [
            {"role": "user", "content": rng.choice(_NOISE_TEMPLATES)}
            for _ in range(messages_per_noise_session)
        ]
        persona["sessions"].append({"id": sid, "messages": msgs})

    return persona


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m benchmark.generate_persona",
        description="Inflate a base persona with N noise sessions.",
    )
    p.add_argument("--base", type=Path, required=True, help="base persona JSON")
    p.add_argument("--noise-sessions", type=int, default=0)
    p.add_argument("--messages-per-noise-session", type=int, default=3)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=Path, required=True, help="output JSON path")
    args = p.parse_args(argv)

    with open(args.base, "r", encoding="utf-8") as fh:
        base = json.load(fh)

    persona = generate(
        base,
        noise_sessions=args.noise_sessions,
        messages_per_noise_session=args.messages_per_noise_session,
        seed=args.seed,
    )

    errors = validate_persona(persona)
    if errors:
        print("[error] generated persona is invalid:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 2

    args.out.write_text(json.dumps(persona, indent=2), encoding="utf-8")
    msgs = sum(len(s["messages"]) for s in persona["sessions"])
    print(f"wrote {args.out}: {len(persona['sessions'])} sessions, {msgs} messages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
