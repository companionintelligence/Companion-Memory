#!/usr/bin/env python3
"""Hybrid retrieval test: CI-Server graph context UNION naive RAG chunks.

Hypothesis (from the data): naive vector RAG (78.3%) outscores CI-Server's graph
(75.9%), so the raw-text chunks capture facts the graph serialisation loses.
Supplementing graph traversal WITH naive chunks may beat either alone.

This is the cheapest faithful test of that idea — no re-ingest, no CI-Server
change. Per question we retrieve from BOTH existing containers and feed the union
to the SAME answerer + the SAME judges the real runs use:

    ctx = ci_server(:9104).retrieve(q)  ∪  naive(:9101).retrieve(q)
    ans = answerer.answer(q, ctx)        # identical module, ornstein held constant

Run detached (≈48 min, ornstein). Writes report_expanded_hybrid.md.
"""
import concurrent.futures
import json
from pathlib import Path

from app import answerer
from orchestrator import post, judge_answer, judge_existence, judge_storage

PERSONA = "../personas/max_expanded_large.json"
CI_URL = "http://localhost:9104"
NAIVE_URL = "http://localhost:9101"
OUT = "report_expanded_hybrid.md"
CONCURRENCY = 4


def hybrid_retrieve(query: str) -> list[str]:
    """Graph context first (terse, structured), then naive chunks (raw text),
    de-duplicated, order-preserving."""
    ci = post(f"{CI_URL}/retrieve", {"query": query}).get("contexts", []) or []
    naive = post(f"{NAIVE_URL}/retrieve", {"query": query}).get("contexts", []) or []
    seen: set = set()
    merged: list[str] = []
    for c in list(ci) + list(naive):
        c = (c or "").strip()
        if c and c not in seen:
            seen.add(c)
            merged.append(c)
    return merged


def score_one(q: dict) -> dict:
    gold = q.get("answer") or ", ".join(q.get("keywords", []))
    try:
        ctx = hybrid_retrieve(q["question"])
        ans = answerer.answer(q["question"], ctx)
        cat = q.get("category")
        if cat == "enumeration":
            members = [m.lower() for m in q.get("keywords", [])]
            al = ans.lower()
            cl = " ".join(ctx).lower()
            hit_a = sum(1 for m in members if m in al)
            hit_s = sum(1 for m in members if m in cl)
            a_ok = hit_a / len(members) if members else 0.0
            s_ok = hit_s / len(members) if members else 0.0
            a_why = f"set-recall {hit_a}/{len(members)}"
        elif cat in ("absence", "presence-control"):
            ok, a_why = judge_existence(q["question"], gold, ans)
            a_ok = s_ok = float(bool(ok))
        else:
            a_ok, a_why = judge_answer(q["question"], gold, ans)
            s_ok, _ = judge_storage(q["question"], gold, ctx)
            a_ok, s_ok = float(bool(a_ok)), float(bool(s_ok))
    except Exception as exc:  # noqa: BLE001 — one bad question must not abort the run
        ans, a_ok, s_ok, a_why = f"(error: {exc})", 0.0, 0.0, str(exc)
    return {"id": q["id"], "category": q["category"], "answer_ok": a_ok,
            "store_ok": s_ok, "answer": ans, "reason": a_why}


def _mk(v: float) -> str:
    return "✓" if v >= 0.999 else ("~" if v > 0 else "✗")


def main() -> None:
    persona = json.loads(Path(PERSONA).read_text())
    qs = persona["eval_questions"]
    n = len(qs)
    print(f"HYBRID (ci_server ∪ naive) — {n} questions, concurrency {CONCURRENCY}")
    results_by_id: dict = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futs = {ex.submit(score_one, q): q["id"] for q in qs}
        for fut in concurrent.futures.as_completed(futs):
            r = fut.result()
            results_by_id[r["id"]] = r
            done += 1
            print(f"    [{done}/{n}] {_mk(r['answer_ok'])}ans {_mk(r['store_ok'])}store  "
                  f"{r['id']} ({r['category']})  {r['answer'][:50]!r}")

    rows = [results_by_id[q["id"]] for q in qs]
    cats: list[str] = []
    for q in qs:
        if q["category"] not in cats:
            cats.append(q["category"])
    ans_hits = sum(r["answer_ok"] for r in rows)
    store_hits = sum(r["store_ok"] for r in rows)
    per = {c: sum(r["answer_ok"] for r in rows if r["category"] == c) for c in cats}
    tot = {c: sum(1 for r in rows if r["category"] == c) for c in cats}
    cells = " | ".join(f"{per[c]:.1f}/{tot[c]}" for c in cats)
    L = [f"# Memory Benchmark v2 — {persona['name']} — HYBRID (graph ∪ naive)", "",
         f"> {n} questions · ci_server(:9104) ∪ naive(:9101) retrieval · same answerer+judge",
         "", "## Scores", "",
         "| System | Answer | Storage | " + " | ".join(cats) + " |",
         "|" + "|".join(["---"] * (3 + len(cats))) + "|",
         f"| hybrid | **{ans_hits:.1f}/{n}** | {store_hits:.1f}/{n} | {cells} |"]
    report = "\n".join(L) + "\n"
    Path(OUT).write_text(report, encoding="utf-8")
    print(f"\n  ANSWER {ans_hits:.1f}/{n}   STORAGE {store_hits:.1f}/{n}")
    print("\n" + report)


if __name__ == "__main__":
    main()
