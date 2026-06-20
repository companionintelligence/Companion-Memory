#!/usr/bin/env python3
"""Tune the hybrid merge strategy (graph ∪ naive) on a soft-spot-weighted subset.

Baseline concat hit 90.4% but trails the per-category leaders on relational
(82 vs naive 86) and multi-hop (101 vs mem0 109) — the union dilutes. This sweeps
merge strategies to see if capping / re-ranking lifts those without losing the
rest, BEFORE we bake one into RecallService.

Retrieval (graph :9104 + naive :9101) is fetched ONCE per question and cached;
only the answer+judge cost is paid per (question, strategy). Same answerer +
judges as the real runs. Run detached. Writes /tmp/hybrid_tune_result.md.
"""
import concurrent.futures
import json
import re
from pathlib import Path

from app import answerer
from orchestrator import post, judge_answer, judge_existence, judge_storage

PERSONA = "../personas/max_expanded_large.json"
CI_URL = "http://localhost:9104"
NAIVE_URL = "http://localhost:9101"
OUT = "/tmp/hybrid_tune_result.md"
CONCURRENCY = 4

# Soft-spot-weighted subset: extra relational + multi-hop, all categories covered.
SUBSET_PER_CAT = {
    "relational": 24, "multi-hop": 24, "temporal-update": 12, "flat-recall": 10,
    "enumeration": 8, "absence": 10, "aggregation": 8, "presence-control": 8,
}

_WORD = re.compile(r"[a-z0-9]+")


def _dedup(seq):
    seen, out = set(), []
    for c in seq:
        c = (c or "").strip()
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _toks(s):
    return set(_WORD.findall(s.lower()))


# --- merge strategies: (query, graph_list, naive_list) -> merged context list ---
def m_concat(q, g, n):
    return _dedup(list(g) + list(n))


def m_concat_cap(cap):
    def f(q, g, n):
        return _dedup(list(g) + list(n))[:cap]
    return f


def m_rrf(cap, k=60):
    def f(q, g, n):
        score = {}
        for lst in (g, n):
            for rank, item in enumerate(lst):
                item = (item or "").strip()
                if not item:
                    continue
                score[item] = score.get(item, 0.0) + 1.0 / (k + rank)
        ranked = sorted(score, key=lambda it: score[it], reverse=True)
        return ranked[:cap]
    return f


def m_lexrank(cap):
    def f(q, g, n):
        qt = _toks(q)
        merged = _dedup(list(g) + list(n))
        # stable sort by overlap desc; ties keep original (graph-first) order
        scored = sorted(enumerate(merged),
                        key=lambda p: (-len(_toks(p[1]) & qt), p[0]))
        return [m for _, m in scored][:cap]
    return f


STRATEGIES = {
    "concat(all)": m_concat,
    "rrf(12)": m_rrf(12),
    "rrf(16)": m_rrf(16),
    "lexrank(12)": m_lexrank(12),
}


def pick_subset(qs):
    out, counts = [], {c: 0 for c in SUBSET_PER_CAT}
    for q in qs:
        c = q["category"]
        if c in counts and counts[c] < SUBSET_PER_CAT[c]:
            out.append(q)
            counts[c] += 1
    return out


def judge(q, ans, ctx):
    """Return (answer_ok, store_ok) using the same per-category rules as orchestrator."""
    gold = q.get("answer") or ", ".join(q.get("keywords", []))
    cat = q.get("category")
    if cat == "enumeration":
        members = [m.lower() for m in q.get("keywords", [])]
        al, cl = ans.lower(), " ".join(ctx).lower()
        a_ok = (sum(1 for m in members if m in al) / len(members)) if members else 0.0
        s_ok = (sum(1 for m in members if m in cl) / len(members)) if members else 0.0
        return a_ok, s_ok
    if cat in ("absence", "presence-control"):
        ok, _ = judge_existence(q["question"], gold, ans)
        return float(bool(ok)), float(bool(ok))
    a_ok, _ = judge_answer(q["question"], gold, ans)
    s_ok, _ = judge_storage(q["question"], gold, ctx)
    return float(bool(a_ok)), float(bool(s_ok))


def main():
    persona = json.loads(Path(PERSONA).read_text())
    subset = pick_subset(persona["eval_questions"])
    cats = list(SUBSET_PER_CAT)
    print(f"subset = {len(subset)} questions; strategies = {list(STRATEGIES)}")

    # 1) cache raw retrieval per question (graph + naive), once.
    def fetch(q):
        g = post(f"{CI_URL}/retrieve", {"query": q["question"]}).get("contexts", []) or []
        n = post(f"{NAIVE_URL}/retrieve", {"query": q["question"]}).get("contexts", []) or []
        return q["id"], (list(g), list(n))
    retr = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        for qid, gn in ex.map(fetch, subset):
            retr[qid] = gn
    print(f"cached retrieval for {len(retr)} questions")

    # 2) score every (question, strategy) — answer+judge, concurrent.
    def score(task):
        q, sname = task
        g, n = retr[q["id"]]
        ctx = STRATEGIES[sname](q["question"], g, n)
        try:
            ans = answerer.answer(q["question"], ctx)
            a_ok, s_ok = judge(q, ans, ctx)
        except Exception as exc:  # noqa: BLE001
            a_ok, s_ok = 0.0, 0.0
        return sname, q["category"], a_ok, s_ok

    tasks = [(q, s) for q in subset for s in STRATEGIES]
    agg = {s: {"a": 0.0, "s": 0.0, "cat": {c: 0.0 for c in cats}} for s in STRATEGIES}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        for sname, cat, a_ok, s_ok in ex.map(score, tasks):
            agg[sname]["a"] += a_ok
            agg[sname]["s"] += s_ok
            agg[sname]["cat"][cat] += a_ok
            done += 1
            if done % 40 == 0:
                print(f"  scored {done}/{len(tasks)}")

    tot = {c: sum(1 for q in subset if q["category"] == c) for c in cats}
    N = len(subset)
    L = [f"# Hybrid merge tuning — {N}Q soft-spot-weighted subset", "",
         "| Strategy | Answer | Storage | " + " | ".join(cats) + " |",
         "|" + "|".join(["---"] * (3 + len(cats))) + "|"]
    for s in STRATEGIES:
        cells = " | ".join(f"{agg[s]['cat'][c]:.1f}/{tot[c]}" for c in cats)
        L.append(f"| {s} | **{agg[s]['a']:.1f}/{N}** ({100*agg[s]['a']/N:.1f}%) | "
                 f"{agg[s]['s']:.1f}/{N} | {cells} |")
    report = "\n".join(L) + "\n"
    Path(OUT).write_text(report, encoding="utf-8")
    print("\n" + report)


if __name__ == "__main__":
    main()
