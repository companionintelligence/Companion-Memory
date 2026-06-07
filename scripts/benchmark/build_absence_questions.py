#!/usr/bin/env python3
"""
Negative / absence ("anti-hallucination") question set over the existing 100Q facts.

Premise: to correctly answer "Does Max have a brother?" -> "no", a system must know
the COMPLETE, bounded set of Max's siblings. A knowledge graph returns that bounded
typed neighborhood; flat vector RAG returns a fuzzy top-k that, under 400 distractors,
often surfaces a *tempting* but wrong fact (a cousin's dog, a friend's employer) and
hallucinates a "yes". Every absence question below is baited with exactly such a
distractor that exists in the corpus about SOMEONE ELSE.

Controls: 7 genuine "yes" questions so a system that blindly answers "no" can't game it.

Graded by an existence-aware judge (yes/no must match ground truth; a confident "yes"
to something that doesn't exist = wrong; "I don't know" = wrong).

Output: personas/max_turnquist_absence.json  (run Phase B with --skip-ingest)
"""

from __future__ import annotations
import json
from pathlib import Path

SRC = Path("personas/max_turnquist_100_large.json")
OUT = Path("personas/max_turnquist_absence.json")


def Q(i, question, truth, category):
    return {"id": f"n{i:02d}", "question": question, "answer": truth, "keywords": [], "category": category}


ABSENCE = [
    Q(1,  "Does Max have a brother?",                "No — Max has one sibling, a sister named Anita; no brother. (His brother-in-law Raj is not his brother.)", "absence"),
    Q(2,  "Does Max own a dog?",                     "No — Max's only pet is a cat named Biryani.", "absence"),
    Q(3,  "Does Max play the piano?",                "No — Max plays the violin. (His grandmother was a pianist, not him.)", "absence"),
    Q(4,  "Does Max have any children of his own?",  "No — Max has a niece (Mira) and a nephew (Felix), but no children of his own.", "absence"),
    Q(5,  "Is Max married?",                         "No — Max is engaged to Sam, not married.", "absence"),
    Q(6,  "Has Max ever lived in Seattle?",          "No — Max has only lived in Portland and Denver.", "absence"),
    Q(7,  "Does Max work at Stripe?",                "No — Max works at Cobalt Robotics. Stripe is where his friend Lena works.", "absence"),
    Q(8,  "Does Max have a pet named Rufus?",        "No — Max's pet is a cat named Biryani. (Rufus is a distractor pet belonging to someone else.)", "absence"),
    Q(9,  "Is Max vegan?",                           "No — Max is vegetarian, not vegan.", "absence"),
    Q(10, "Does Max currently play soccer?",         "No — Max used to play soccer but now trains for marathons.", "absence"),
    Q(11, "Does Max own a motorcycle?",              "No — Max drives a Subaru Outback and rides a Cannondale road bike.", "absence"),
    Q(12, "Does Max have a sister named Priya?",     "No — Max's sister is named Anita.", "absence"),
    Q(13, "Has Max ever worked at Google?",          "No — Max has worked at Cobalt Robotics and Northwind Logistics.", "absence"),
    Q(14, "Does Max play the guitar?",               "No — Max plays the violin.", "absence"),
    Q(15, "Does Max have a second cat?",             "No — Max has one cat, Biryani.", "absence"),
    Q(16, "Is Max fluent in Mandarin?",              "No — Max is learning Japanese, not Mandarin.", "absence"),
]

CONTROLS = [  # genuine 'yes' — guards against a system that always says no
    Q(17, "Does Max have a sister?",                 "Yes — his sister Anita.", "presence-control"),
    Q(18, "Does Max own a cat?",                     "Yes — a cat named Biryani.", "presence-control"),
    Q(19, "Does Max play a musical instrument?",     "Yes — the violin.", "presence-control"),
    Q(20, "Is Max engaged?",                         "Yes — to his partner Sam.", "presence-control"),
    Q(21, "Has Max lived in Denver?",                "Yes — he currently lives in Denver.", "presence-control"),
    Q(22, "Does Max work at Cobalt Robotics?",       "Yes — he currently works there, leading the perception team.", "presence-control"),
    Q(23, "Does Max have a niece?",                  "Yes — his niece Mira.", "presence-control"),
]


def main() -> None:
    out = dict(json.loads(SRC.read_text()))
    out["persona_id"] = "max_turnquist_absence"
    out["description"] = "Negative/absence (anti-hallucination) probe over the 100Q facts: baited absence questions + presence controls, existence-judged."
    out["eval_questions"] = ABSENCE + CONTROLS
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    from collections import Counter
    print(f"Wrote {OUT}  ({len(out['eval_questions'])} questions: {dict(Counter(q['category'] for q in out['eval_questions']))})")


if __name__ == "__main__":
    main()
