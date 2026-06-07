#!/usr/bin/env python3
"""
Build a STRUCTURED / agentic-memory question set over the EXISTING 100Q facts.

These probe the same canonical facts already ingested in every store, but in the
ways a knowledge graph is built for and a flat vector store struggles with:

  - temporal-update : current-vs-past value of facts that changed over time
  - enumeration     : "list all X" — scored by SET RECALL over the gold members
  - aggregation     : "how many / which" — count or single-fact, binary judged

Reuses the 100Q sessions verbatim (so stores match / it stays re-ingestable),
swaps in the structured eval_questions. Run Phase B with --skip-ingest against
the already-built stores.

Output: personas/max_turnquist_struct.json
"""

from __future__ import annotations
import json
from pathlib import Path

SRC = Path("personas/max_turnquist_100_large.json")
OUT = Path("personas/max_turnquist_struct.json")


def Q(i, question, answer, category, keywords):
    return {"id": f"s{i:02d}", "question": question, "answer": answer,
            "keywords": keywords, "category": category}


# --- temporal-update: current AND prior value of facts that changed --------- #
TEMPORAL = [
    Q(1,  "What city does Max currently live in?", "Denver", "temporal-update", ["Denver"]),
    Q(2,  "What city did Max live in before his current one?", "Portland", "temporal-update", ["Portland"]),
    Q(3,  "What company does Max currently work for?", "Cobalt Robotics", "temporal-update", ["Cobalt"]),
    Q(4,  "What company did Max work for before his current job?", "Northwind Logistics", "temporal-update", ["Northwind"]),
    Q(5,  "What phone does Max currently use?", "a Pixel", "temporal-update", ["Pixel"]),
    Q(6,  "What phone did Max use before his current one?", "an iPhone", "temporal-update", ["iPhone"]),
    Q(7,  "What car does Max currently drive?", "a Subaru Outback", "temporal-update", ["Subaru"]),
    Q(8,  "What car did Max drive before his current one?", "a Civic", "temporal-update", ["Civic"]),
    Q(9,  "What type of home does Max currently live in?", "a house", "temporal-update", ["house"]),
    Q(10, "What type of home did Max live in before?", "an apartment", "temporal-update", ["apartment"]),
    Q(11, "What is Max's current diet?", "vegetarian", "temporal-update", ["vegetarian"]),
    Q(12, "What did Max eat before going vegetarian?", "meat", "temporal-update", ["meat"]),
    Q(13, "What programming language does Max mainly use now?", "Rust", "temporal-update", ["Rust"]),
    Q(14, "What programming language did Max mainly use before?", "C++", "temporal-update", ["C++"]),
    Q(15, "What does Max currently train for?", "marathons", "temporal-update", ["marathon"]),
    Q(16, "What sport did Max play before switching to marathon training?", "soccer", "temporal-update", ["soccer"]),
    Q(17, "What is Max's current relationship status?", "engaged", "temporal-update", ["engaged"]),
    Q(18, "How did Max correct his vision last spring?", "LASIK", "temporal-update", ["LASIK"]),
    Q(19, "What is Max's current job title?", "senior engineer", "temporal-update", ["senior engineer"]),
    Q(20, "What team does Max currently lead?", "the perception team", "temporal-update", ["perception"]),
]

# --- enumeration: SET RECALL over canonical members (no distractor people) --- #
ENUMERATION = [
    Q(21, "List all of Max's family members.", "Anita, Deepak, Sunita, Raj, Mira, Felix, Sam, Nana Rose, Bashir",
      "enumeration", ["Anita", "Deepak", "Sunita", "Raj", "Mira", "Felix", "Sam", "Rose", "Bashir"]),
    Q(22, "Name every company Max has worked for.", "Cobalt Robotics, Northwind Logistics",
      "enumeration", ["Cobalt", "Northwind"]),
    Q(23, "List the musical instruments played by people in Max's life.", "violin, viola, harp",
      "enumeration", ["violin", "viola", "harp"]),
    Q(24, "Who are all of Max's friends?", "Lena, Diego, Yusuf",
      "enumeration", ["Lena", "Diego", "Yusuf"]),
    Q(25, "List all the cities Max has lived in.", "Portland, Denver",
      "enumeration", ["Portland", "Denver"]),
    Q(26, "Name all of Max's blood relatives (not in-laws).", "Anita, Deepak, Sunita, Mira, Felix, Nana Rose, Bashir",
      "enumeration", ["Anita", "Deepak", "Sunita", "Mira", "Felix", "Rose", "Bashir"]),
    Q(27, "List Max's hobbies and activities.", "violin, hiking, climbing, marathons, surfing",
      "enumeration", ["violin", "hiking", "climbing", "marathon", "surf"]),
    Q(28, "Name the cities where Max's relatives live.", "Portland, Chicago",
      "enumeration", ["Portland", "Chicago"]),
    Q(29, "Who are the people Max works with directly?", "Priyanka, Imani",
      "enumeration", ["Priyanka", "Imani"]),
    Q(30, "List the languages Max has studied or is learning.", "Japanese",
      "enumeration", ["Japanese"]),
]

# --- aggregation: counts / single-target filters (binary judged) ------------ #
AGGREGATION = [
    Q(31, "How many cities has Max lived in?", "two (Portland and Denver)", "aggregation", ["two", "2"]),
    Q(32, "How many companies has Max worked for?", "two (Cobalt Robotics and Northwind Logistics)", "aggregation", ["two", "2"]),
    Q(33, "How many children does Max's sister Anita have?", "two (Mira and Felix)", "aggregation", ["two", "2"]),
    Q(34, "How many siblings does Max have?", "one (his sister Anita)", "aggregation", ["one", "1"]),
    Q(35, "Which of Max's relatives works in medicine?", "Raj, his brother-in-law (a cardiologist)", "aggregation", ["Raj"]),
    Q(36, "How many instruments are played by people in Max's life?", "three (violin, viola, harp)", "aggregation", ["three", "3"]),
    Q(37, "Which member of Max's family is an architect?", "his sister Anita", "aggregation", ["Anita"]),
]


def main() -> None:
    src = json.loads(SRC.read_text())
    out = dict(src)
    out["persona_id"] = "max_turnquist_struct"
    out["description"] = "Structured / agentic-memory question set over the 100Q facts: temporal supersession, relationship enumeration (set-recall), aggregation."
    out["eval_questions"] = TEMPORAL + ENUMERATION + AGGREGATION
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    from collections import Counter
    cats = Counter(q["category"] for q in out["eval_questions"])
    print(f"Wrote {OUT}  ({len(out['eval_questions'])} questions: {dict(cats)})")


if __name__ == "__main__":
    main()
