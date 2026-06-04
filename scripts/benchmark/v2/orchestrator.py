#!/usr/bin/env python3
"""
Harness v2 orchestrator (runs on the host).

Talks ONLY the uniform HTTP contract to each system container. Two scored
phases per system, both via an LLM judge:

  1. ANSWER accuracy   — POST /answer{question}; judge the generated answer vs gold.
  2. STORAGE fidelity  — POST /retrieve{query=question}; judge whether the gold
                         fact is actually present in the raw retrieved memory
                         (isolates "did it store + surface the fact" from "did
                         the answerer phrase it well").

Usage:
  python orchestrator.py --persona ../personas/max_turnquist_50_large.json \
      --systems naive=http://localhost:9101,mem0=http://localhost:9102,\
ci_server=http://localhost:9104,hindsight=http://localhost:9103 \
      --out report_v2.md
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
import urllib.request
from pathlib import Path

JUDGE_URL = "http://192.168.0.203:1234"
JUDGE_MODEL = "ornstein-3.6-27b"

# CI-Server account (for the out-of-band full-wipe; sidecar only uses the API).
CI_OWNER_QUERY = "SELECT id::text || '|' || COALESCE(entity_id::text,'') FROM ci.users WHERE entity_id IS NOT NULL ORDER BY id LIMIT 1;"
DB_CONTAINER = "ci-server-database-1"


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #

def post(url: str, payload: dict, timeout: float = 700.0) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
    return json.loads(body) if body else {}


# --------------------------------------------------------------------------- #
# Judges
# --------------------------------------------------------------------------- #

_ANS_SCHEMA = {"type": "object", "properties": {"correct": {"type": "boolean"}, "reason": {"type": "string"}},
               "required": ["correct", "reason"], "additionalProperties": False}


def _judge(system_prompt: str, user_msg: str) -> tuple[bool, str]:
    payload = {
        "model": JUDGE_MODEL,
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_msg}],
        "temperature": 0,
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "verdict", "strict": True, "schema": _ANS_SCHEMA}},
    }
    try:
        data = post(f"{JUDGE_URL}/v1/chat/completions", payload, timeout=120)
        msg = data.get("choices", [{}])[0].get("message", {})
        v = json.loads(msg.get("content") or msg.get("reasoning_content") or "{}")
        return bool(v.get("correct")), str(v.get("reason", ""))
    except Exception as exc:  # noqa: BLE001
        return False, f"judge error: {exc}"


_ANSWER_JUDGE = (
    "You grade a personal-assistant answer. Given QUESTION, GOLD ANSWER, and the "
    "assistant's ANSWER, decide if the ANSWER is correct. 'the user'/'I'/the "
    "subject's name all refer to the same person. Paraphrases count. correct=false "
    "if the answer is 'I don't know', wrong, or unsupported."
)
_STORAGE_JUDGE = (
    "You check whether a memory system actually stored a fact. Given QUESTION, "
    "GOLD ANSWER, and the raw RETRIEVED MEMORY snippets, decide if the gold fact "
    "is present/derivable in the snippets. 'the user'/the subject's name corefer. "
    "correct=true only if the snippets contain the gold fact."
)


def judge_answer(q: str, gold: str, ans: str) -> tuple[bool, str]:
    return _judge(_ANSWER_JUDGE, f"QUESTION: {q}\nGOLD ANSWER: {gold}\nANSWER: {ans}")


def judge_storage(q: str, gold: str, contexts: list[str]) -> tuple[bool, str]:
    mem = "\n".join(f"- {c}" for c in contexts) or "(nothing retrieved)"
    return _judge(_STORAGE_JUDGE, f"QUESTION: {q}\nGOLD ANSWER: {gold}\nRETRIEVED MEMORY:\n{mem}")


# --------------------------------------------------------------------------- #
# CI-Server out-of-band full wipe (preserve canonical node) — same as v1
# --------------------------------------------------------------------------- #

def _psql(sql: str) -> str:
    out = subprocess.run(["docker", "exec", DB_CONTAINER, "psql", "-U", "companion", "-d", "companion", "-tAc", sql],
                         capture_output=True, text=True, timeout=20)
    return out.stdout.strip()


def ci_server_wipe() -> str:
    row = _psql(CI_OWNER_QUERY)
    if "|" not in row:
        return "no canonical user; skipped"
    owner, canon = (s.strip() for s in row.split("|", 1))
    _psql("DELETE FROM ci.agent_memories WHERE source='benchmark';")
    _psql(f"DELETE FROM ci.graph_deltas WHERE owner_user_id='{owner}';")
    _psql(f"DELETE FROM ci.relationships WHERE owner_user_id='{owner}';")
    _psql(f"DELETE FROM ci_search.embeddings WHERE user_id='{owner}' AND entity_id<>'{canon}';")
    _psql(f"DELETE FROM ci_search.vectors WHERE user_id='{owner}' AND entity_id<>'{canon}';")
    n = _psql(f"DELETE FROM ci.entities WHERE owner_user_id='{owner}' AND entity_id<>'{canon}' RETURNING 1;")
    return f"wiped {len(n.splitlines()) if n else 0} entities (canonical preserved)"


# --------------------------------------------------------------------------- #
# Run one system
# --------------------------------------------------------------------------- #

def run_system(name: str, url: str, persona: dict, skip_ingest: bool = False) -> dict:
    print(f"\n{'='*60}\n  {name}  ({url})\n{'='*60}")
    health = post(f"{url}/health", {}) if False else json.loads(
        urllib.request.urlopen(f"{url}/health", timeout=10).read())
    print(f"  health: {health}")

    if skip_ingest:
        print("  skip-ingest: scoring against the EXISTING graph (no wipe/ingest/flush)")
    else:
        if name == "ci_server":
            print(f"  CI-Server wipe: {ci_server_wipe()}")
        post(f"{url}/reset", {})

        msgs = [(m["content"], s["id"]) for s in persona["sessions"] for m in s["messages"] if m["role"] == "user"]
        print(f"  ingesting {len(msgs)} statements…")
        t0 = time.monotonic()
        fails = 0
        for text, sid in msgs:
            try:
                post(f"{url}/ingest", {"text": text, "session_id": sid})
            except Exception as exc:  # noqa: BLE001 — one bad ingest must not abort the run
                fails += 1
                print(f"    [warn] ingest failed ({exc}); continuing")
        # /flush blocks server-side until compaction completes (container deadline
        # 1800s). The HTTP call must out-wait that, or it aborts mid-compaction —
        # 342 fragments at BATCH_SIZE=4 ≈ 12 min. 700s default was too short.
        post(f"{url}/flush", {}, timeout=2000)
        print(f"  ingest+flush done ({time.monotonic()-t0:.0f}s, {fails} ingest failures)")

    rows = []
    ans_hits = store_hits = 0
    for q in persona["eval_questions"]:
        gold = q.get("answer") or ", ".join(q.get("keywords", []))
        resp = post(f"{url}/answer", {"question": q["question"]})
        ans, ctx = resp.get("answer", ""), resp.get("contexts", [])
        a_ok, a_why = judge_answer(q["question"], gold, ans)
        s_ok, _ = judge_storage(q["question"], gold, ctx)
        ans_hits += a_ok
        store_hits += s_ok
        rows.append({"id": q["id"], "category": q["category"], "answer_ok": a_ok, "store_ok": s_ok,
                     "answer": ans, "reason": a_why})
        print(f"    {'✓' if a_ok else '✗'}ans {'✓' if s_ok else '✗'}store  {q['id']} ({q['category']})  {ans[:50]!r}")

    n = len(persona["eval_questions"])
    print(f"  ANSWER {ans_hits}/{n}   STORAGE {store_hits}/{n}")
    return {"name": name, "n": n, "answer": ans_hits, "storage": store_hits, "rows": rows}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--persona", required=True)
    ap.add_argument("--systems", required=True, help="name=url,name=url")
    ap.add_argument("--out", default="report_v2.md")
    ap.add_argument("--skip-ingest", action="store_true",
                    help="score against the existing graph; skip wipe/ingest/flush")
    args = ap.parse_args()

    persona = json.loads(Path(args.persona).read_text())
    systems = [tuple(s.split("=", 1)) for s in args.systems.split(",")]

    results = [run_system(name, url, persona, args.skip_ingest) for name, url in systems]

    cats = []
    for q in persona["eval_questions"]:
        if q["category"] not in cats:
            cats.append(q["category"])

    L = [f"# Memory Benchmark v2 — {persona['name']}", "",
         f"> {len(persona['eval_questions'])} questions · containerized · retrieval-augmented answerer · LLM judge",
         "", "## Scores", "",
         "| System | Answer | Storage | " + " | ".join(cats) + " |",
         "|" + "|".join(["---"] * (3 + len(cats))) + "|"]
    for r in results:
        per = {c: sum(1 for x in r["rows"] if x["category"] == c and x["answer_ok"]) for c in cats}
        tot = {c: sum(1 for x in r["rows"] if x["category"] == c) for c in cats}
        cells = " | ".join(f"{per[c]}/{tot[c]}" for c in cats)
        L.append(f"| {r['name']} | **{r['answer']}/{r['n']}** | {r['storage']}/{r['n']} | {cells} |")
    report = "\n".join(L) + "\n"
    Path(args.out).write_text(report, encoding="utf-8")
    print("\n" + report)


if __name__ == "__main__":
    main()
