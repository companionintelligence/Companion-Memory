#!/usr/bin/env python3
"""
Build the 100-question Max Turnquist BASE persona.

Reconstructs the canonical (non-noise) content + 50 questions from the existing
*_50_large file, then extends it with ~50 new facts that add many new entities
and relationships (Sam, Theo, Felix, Imani, Priyanka's history, Okafor's
university, etc.) and 50 new questions weighted toward relational / multi-hop to
exercise the graph. Names/values are chosen to NOT collide with the distractor
pools in generate_large_persona.py.

Output: personas/max_turnquist_100.json  (a BASE; run generate_large_persona.py
on it to bury the facts under distractor noise).
"""

from __future__ import annotations

import json
from pathlib import Path

SRC = Path("personas/max_turnquist_50_large.json")
OUT = Path("personas/max_turnquist_100.json")

# --------------------------------------------------------------------------- #
# New canonical fact sessions (first-person Max statements). Each gold answer
# below is supported by exactly one of these lines.
# --------------------------------------------------------------------------- #

NEW_SESSIONS = [
    ("sess_13", [
        "Sam, my fiancé, is a veterinarian at a clinic called Brightpath Animal Hospital.",
        "Sam and I first met at the Mesa Rim climbing gym, actually.",
        "Sam plays the viola in a community orchestra.",
    ]),
    ("sess_14", [
        "My best friend Lena's partner is named Theo.",
        "Theo is a pastry chef and runs a little bakery-cafe.",
        "Lena grew up in Vancouver before she moved to the Bay Area.",
        "At Stripe, Lena's actual role is product designer.",
    ]),
    ("sess_15", [
        "Anita's architecture firm is called Hargrove & Field.",
        "Besides Mira, my sister Anita has a younger son — my nephew Felix.",
        "Felix just turned three and is obsessed with dinosaurs.",
    ]),
    ("sess_16", [
        "My brother-in-law Raj works at Meridian General hospital.",
        "Raj is a serious tennis player and competes most weekends.",
        "Raj grew up in London and came here for his medical residency.",
    ]),
    ("sess_17", [
        "Before Cobalt, my manager Priyanka spent years at Lumen Labs.",
        "Priyanka did her PhD at Caltech.",
    ]),
    ("sess_18", [
        "My old college roommate Diego is a lawyer now and lives in Montreal.",
        "Diego and I both studied at Halford University.",
        "Diego recently had a daughter named Ines.",
    ]),
    ("sess_19", [
        "Professor Okafor, my mentor, also teaches at Halford University.",
        "Halford University is in Montreal.",
        "Okafor just won an award called the Turing Robotics Prize.",
    ]),
    ("sess_20", [
        "My niece Mira is learning the harp.",
        "Mira does gymnastics every Saturday.",
    ]),
    ("sess_21", [
        "My grandmother, Nana Rose, lives in a retirement community back in Portland.",
        "Nana Rose was a concert pianist in her younger years.",
        "My uncle on my mom's side, Bashir, runs a bakery in Portland.",
    ]),
    ("sess_22", [
        "Our perception team's flagship project is a warehouse robot codenamed Magpie.",
        "On the team I work most closely with my teammate Imani.",
        "Imani joined Cobalt from an aerospace company called Aerolith.",
    ]),
    ("sess_23", [
        "I wear a Garmin watch to track my marathon training.",
        "My work laptop is a ThinkPad, but at home I use a Mac.",
        "I started a running club with my friend Yusuf.",
        "My dentist, Dr. Cardoza, has been seeing me for years.",
    ]),
    ("sess_24", [
        "My comfort TV show is The Bear; I've watched it three times.",
        "The favorite city I've ever traveled to is Lisbon.",
        "I'm allergic to penicillin — found out the hard way as a kid.",
        "My favorite dessert is crème brûlée.",
        "My favorite holiday is Diwali.",
    ]),
    ("sess_25", [
        "I recently started taking surfing lessons on weekends.",
        "I collect vintage film cameras — got three on a shelf.",
        "Funny enough, I'm afraid of heights, despite all the climbing.",
        "I drink my tea with oat milk, never dairy.",
        "I could play Catan every night; it's my favorite board game.",
    ]),
    ("sess_26", [  # temporal updates (before/after)
        "For years I coded mostly in C++, but at Cobalt I've switched to Rust.",
        "I wore glasses for years but got LASIK last spring.",
        "I used to live alone, but Sam moved in with me last year.",
        "I quit smoking five years ago after a decade of it.",
        "I deleted all my social media this year.",
    ]),
]

# --------------------------------------------------------------------------- #
# New eval questions q51..q100.
# --------------------------------------------------------------------------- #

def Q(i, question, answer, category, *keywords):
    return {"id": f"q{i:02d}", "question": question, "answer": answer,
            "keywords": list(keywords) or [answer], "category": category}

NEW_QUESTIONS = [
    # ---- flat-recall (direct attributes of Max) ----
    Q(51, "What brand of watch does Max wear?", "Garmin", "flat-recall", "Garmin"),
    Q(52, "What is Max's comfort TV show?", "The Bear", "flat-recall", "The Bear"),
    Q(53, "What is Max's favorite city he has traveled to?", "Lisbon", "flat-recall", "Lisbon"),
    Q(54, "What medication is Max allergic to?", "penicillin", "flat-recall", "penicillin"),
    Q(55, "What is Max's favorite dessert?", "crème brûlée", "flat-recall", "creme brulee", "crème brûlée"),
    Q(56, "What is Max's favorite holiday?", "Diwali", "flat-recall", "Diwali"),
    Q(57, "What is the codename of Max's team's flagship project?", "Magpie", "flat-recall", "Magpie"),
    Q(58, "What computer does Max use at home?", "a Mac", "flat-recall", "Mac"),
    Q(59, "What is Max's work laptop?", "a ThinkPad", "flat-recall", "ThinkPad"),
    Q(60, "What water sport has Max taken up?", "surfing", "flat-recall", "surfing"),
    Q(61, "What does Max collect?", "vintage film cameras", "flat-recall", "film cameras", "cameras"),
    Q(62, "What is Max afraid of?", "heights", "flat-recall", "heights"),
    Q(63, "How does Max take his tea?", "with oat milk", "flat-recall", "oat milk"),
    Q(64, "What board game does Max love?", "Catan", "flat-recall", "Catan"),

    # ---- relational (1 hop from Max, or a named relation's direct attribute) ----
    Q(65, "What is the name of Max's nephew?", "Felix", "relational", "Felix"),
    Q(66, "What is the name of Max's grandmother?", "Nana Rose", "relational", "Rose", "Nana Rose"),
    Q(67, "What is the name of Max's uncle on his mother's side?", "Bashir", "relational", "Bashir"),
    Q(68, "Who is Max's dentist?", "Dr. Cardoza", "relational", "Cardoza"),
    Q(69, "Who is Max's closest teammate on the perception team?", "Imani", "relational", "Imani"),
    Q(70, "Who did Max start a running club with?", "Yusuf", "relational", "Yusuf"),
    Q(71, "Where did Max go to university?", "Halford University", "relational", "Halford"),
    Q(72, "What is the name of Lena's partner?", "Theo", "relational", "Theo"),
    Q(73, "What is the name of Diego's daughter?", "Ines", "relational", "Ines"),
    Q(74, "What hospital does Raj work at?", "Meridian General", "relational", "Meridian General", "Meridian"),
    Q(75, "What is the name of Anita's architecture firm?", "Hargrove & Field", "relational", "Hargrove"),
    Q(76, "What sport does Raj play?", "tennis", "relational", "tennis"),

    # ---- multi-hop (2-3 relations from Max) ----
    Q(77, "What does Max's fiancé do for work?", "veterinarian", "multi-hop", "veterinarian", "vet"),
    Q(78, "What instrument does Max's fiancé play?", "viola", "multi-hop", "viola"),
    Q(79, "Where did Max's best friend grow up?", "Vancouver", "multi-hop", "Vancouver"),
    Q(80, "What is Max's best friend's role at her company?", "product designer", "multi-hop", "product designer"),
    Q(81, "What does Max's best friend's partner do for work?", "pastry chef", "multi-hop", "pastry chef", "chef"),
    Q(82, "What is Max's nephew obsessed with?", "dinosaurs", "multi-hop", "dinosaurs"),
    Q(83, "What instrument is Max's niece learning?", "harp", "multi-hop", "harp"),
    Q(84, "Where does Max's grandmother live?", "Portland", "multi-hop", "Portland"),
    Q(85, "What was Max's grandmother's former profession?", "concert pianist", "multi-hop", "pianist", "concert pianist"),
    Q(86, "Where did Max's manager work before Cobalt Robotics?", "Lumen Labs", "multi-hop", "Lumen Labs"),
    Q(87, "Where did Max's manager earn her PhD?", "Caltech", "multi-hop", "Caltech"),
    Q(88, "In what city does Max's college roommate now live?", "Montreal", "multi-hop", "Montreal"),
    Q(89, "What is the profession of Max's college roommate?", "lawyer", "multi-hop", "lawyer"),
    Q(90, "In what city is Max's mentor's university located?", "Montreal", "multi-hop", "Montreal"),
    Q(91, "Where did Max's teammate Imani work before Cobalt?", "Aerolith", "multi-hop", "Aerolith"),

    # ---- temporal-update (before/after) ----
    Q(92, "What programming language does Max mainly use now?", "Rust", "temporal-update", "Rust"),
    Q(93, "What programming language did Max mainly use before Rust?", "C++", "temporal-update", "C++"),
    Q(94, "Who does Max currently live with?", "Sam", "temporal-update", "Sam"),
    Q(95, "What habit did Max quit five years ago?", "smoking", "temporal-update", "smoking"),
    Q(96, "What did Max delete this year?", "social media", "temporal-update", "social media"),
    Q(97, "What sport did Max play before switching to marathon training?", "soccer", "temporal-update", "soccer"),
    Q(98, "What phone did Max use before his current one?", "an iPhone", "temporal-update", "iPhone"),
    Q(99, "What car did Max drive before his current one?", "a Civic", "temporal-update", "Civic"),
    Q(100, "How did Max correct his vision last spring?", "LASIK", "temporal-update", "LASIK"),
]


def main() -> None:
    src = json.loads(SRC.read_text())
    canonical = [s for s in src["sessions"] if not s["id"].startswith("noise")]

    base = {
        "_comment": "100-question Max Turnquist base. Canonical facts only; run "
                    "generate_large_persona.py to add distractor noise.",
        "persona_id": "max_turnquist_100",
        "name": "Max Turnquist",
        "description": "Max Turnquist — 100-question benchmark persona with a dense "
                       "entity/relationship graph (people, places, employers, "
                       "multi-hop chains, temporal updates).",
        "sessions": canonical + [
            {"id": sid, "messages": [{"role": "user", "content": c} for c in msgs]}
            for sid, msgs in NEW_SESSIONS
        ],
        "eval_questions": src["eval_questions"] + NEW_QUESTIONS,
    }

    OUT.write_text(json.dumps(base, indent=2, ensure_ascii=False), encoding="utf-8")

    from collections import Counter
    cats = Counter(q["category"] for q in base["eval_questions"])
    canon_msgs = sum(1 for s in base["sessions"] for m in s["messages"] if m["role"] == "user")
    ids = [q["id"] for q in base["eval_questions"]]
    assert len(ids) == len(set(ids)), "duplicate question ids!"
    print(f"Wrote {OUT}")
    print(f"  questions: {len(base['eval_questions'])}  by category: {dict(cats)}")
    print(f"  canonical sessions: {len(base['sessions'])}  canonical user-msgs: {canon_msgs}")


if __name__ == "__main__":
    main()
