#!/usr/bin/env python3
"""
Generate a large, noisy variant of a base persona to stress retrieval.

The point: a small persona lets Naive RAG win because the answer-bearing
message is always inside the top-k. To make top-k insufficient we don't just
add random noise (cosine would still surface the one relevant message) — we add
SEMANTIC HARD NEGATIVES: many messages on the SAME topic as each question but
with a different/other value (other people's instruments, other cities visited,
other pets, other jobs), plus temporal muddying (many companies/cities mentioned
over time). That forces the true answer to compete with near-duplicates, so a
fixed top-k starts missing it — which is exactly the regime where structured /
compressed memory should beat raw-chunk retrieval.

Canonical fact messages from the base persona are preserved verbatim, so every
gold answer is still present exactly once; it's just buried.

Usage:
  python generate_large_persona.py --base personas/priya_sharma.json \
      --out personas/priya_sharma_large.json --distractors 160
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

# Hard-negative banks: same topic as the eval questions, different value,
# usually about OTHER people so they never accidentally answer a question.
OTHER_PEOPLE = [
    "my coworker Dan", "my neighbor Wei", "my old roommate Tomas", "my cousin Ravi",
    "my friend Priscilla", "my teammate Olu", "my manager Steph", "my friend Marco",
    "my barista Jules", "my gym buddy Hassan", "my coworker Brenda", "my uncle Vikram",
]

INSTRUMENTS = ["trumpet", "piano", "cello", "drums", "flute", "saxophone", "ukulele", "clarinet"]
PETS = ["a beagle named Rufus", "a corgi", "two goldfish", "a cockatiel", "a husky named Storm",
        "a siamese cat", "a hamster", "a bearded dragon"]
FOODS = ["ramen", "lasagna", "pad thai", "butter chicken", "sushi", "bibimbap", "pho", "tamales"]
BOOKS = ["Dune by Frank Herbert", "Klara and the Sun by Ishiguro", "Project Hail Mary",
         "The Name of the Wind", "Educated by Tara Westover", "Piranesi by Susanna Clarke"]
BIKES = ["a Trek Domane", "a Specialized Tarmac", "a Giant Defy", "an old steel Bianchi",
         "a Canyon Endurace", "a secondhand mountain bike"]
LANGUAGES = ["Spanish", "French", "Korean", "German", "Mandarin", "Italian", "Portuguese"]
CITIES = ["Seattle", "Austin", "Boston", "Atlanta", "Nashville", "Minneapolis", "San Diego",
          "Phoenix", "Pittsburgh", "Sacramento"]
COMPANIES = ["Initech", "Globex", "Hooli", "Vandelay Industries", "Soylent Corp", "Stark Solutions",
             "Wonka Labs", "Acme Freight", "Umbrella Analytics"]
HOBBIES = ["bouldering", "pottery", "salsa dancing", "birdwatching", "baking sourdough",
           "kayaking", "chess", "woodworking"]
JOBS = ["a dentist", "a graphic designer", "a teacher", "an accountant", "a paramedic",
        "a barista", "a data analyst", "a plumber", "a journalist"]

# General filler — broad, low-signal life chatter.
FILLER = [
    "Traffic on the way in was brutal this morning.",
    "Finally cleaned out the garage this weekend.",
    "The coffee machine at the office broke again.",
    "It rained all day, never left the apartment.",
    "Spent the evening reorganizing my closet.",
    "Got way too into a documentary about deep-sea fish last night.",
    "My phone battery has been dying super fast lately.",
    "Tried a new cafe downtown, decent but overpriced.",
    "Long standup meeting, not enough coffee.",
    "Watered the plants and called it a productive day.",
    "The neighbors were loud again until midnight.",
    "Spent an hour just answering emails, ugh.",
    "Weekend plans fell through, just relaxed instead.",
    "New episode dropped and I have thoughts.",
    "Grocery run, forgot half the list of course.",
]


def hard_negatives(rng: random.Random) -> list[str]:
    p = lambda: rng.choice(OTHER_PEOPLE)
    return [
        f"{p()} just started learning the {rng.choice(INSTRUMENTS)} — sounds rough so far.",
        f"{p()} adopted {rng.choice(PETS)} last month.",
        f"{p()} swears their favorite food is {rng.choice(FOODS)}.",
        f"{p()} keeps recommending {rng.choice(BOOKS)} but I haven't started it.",
        f"{p()} just bought {rng.choice(BIKES)} for the commute.",
        f"{p()} is learning {rng.choice(LANGUAGES)} for fun.",
        f"{p()} just got back from a trip to {rng.choice(CITIES)}.",
        f"{p()} is really into {rng.choice(HOBBIES)} these days.",
        f"{p()} took a new job as {rng.choice(JOBS)} in {rng.choice(CITIES)}.",
        f"We have a client over at {rng.choice(COMPANIES)} that keeps changing the spec.",
        f"Had a call with someone from {rng.choice(COMPANIES)} about a partnership.",
        f"{p()} moved to {rng.choice(CITIES)} for the lower rent.",
        f"{p()} plays the {rng.choice(INSTRUMENTS)} in a weekend band.",
        f"Thinking about whether to ever pick up {rng.choice(LANGUAGES)} again.",
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="personas/priya_sharma.json")
    ap.add_argument("--out", default="personas/priya_sharma_large.json")
    ap.add_argument("--distractors", type=int, default=160, help="approx number of distractor messages")
    ap.add_argument("--seed", type=int, default=1234)
    args = ap.parse_args()

    base = json.loads(Path(args.base).read_text())
    rng = random.Random(args.seed)

    # Build a pool of distractor messages: hard negatives + filler, shuffled.
    pool: list[str] = []
    while len(pool) < args.distractors:
        pool.extend(hard_negatives(rng))
        pool.extend(rng.sample(FILLER, k=min(5, len(FILLER))))
    rng.shuffle(pool)
    pool = pool[: args.distractors]

    # Chunk distractors into ~10-message sessions.
    distractor_sessions = []
    for i in range(0, len(pool), 10):
        chunk = pool[i : i + 10]
        distractor_sessions.append({
            "id": f"noise_{i // 10:03d}",
            "messages": [{"role": "user", "content": c} for c in chunk],
        })

    # Canonical sessions first (answers present once), then the noise.
    base["sessions"] = base["sessions"] + distractor_sessions
    base["persona_id"] = base.get("persona_id", "persona") + "_large"
    base["description"] = (
        base.get("description", "")
        + f" [LARGE: +{len(pool)} hard-negative/filler distractor messages to defeat fixed top-k retrieval]"
    )

    Path(args.out).write_text(json.dumps(base, indent=2), encoding="utf-8")

    total_user = sum(1 for s in base["sessions"] for m in s["messages"] if m["role"] == "user")
    print(f"Wrote {args.out}")
    print(f"  total user messages: {total_user}  ({len(pool)} distractors + canonical)")
    print(f"  eval questions: {len(base['eval_questions'])}")
    print(f"  top-10 now covers ~{1000 // total_user}% of messages")


if __name__ == "__main__":
    main()
