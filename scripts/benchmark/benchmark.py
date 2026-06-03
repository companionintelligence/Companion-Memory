#!/usr/bin/env python3
"""
Memory system benchmark — head-to-head comparison.

Usage:
  python benchmark.py [OPTIONS]

  --persona PATH    persona JSON file (default: personas/jordan_rivera.json)
  --systems NAMES   comma-separated list: ci_server,mem0,honcho  (default: ci_server,mem0)
  --out PATH        write Markdown report to this file (default: print to stdout)
  --user-id ID      synthetic user ID to use (default: benchmark_user_001)

Environment variables:
  CI_SERVER_URL     URL of your CI-Server instance (default: http://localhost:8642)
  CI_SERVER_TOKEN   CI-Server API key
  OLLAMA_HOST       Ollama URL for Mem0 (default: http://localhost:11434)

Example:
  CI_SERVER_TOKEN=sk-... python benchmark.py --systems ci_server,mem0
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class EvalQuestion:
    id: str
    question: str
    keywords: list[str]
    category: str


@dataclass
class QuestionResult:
    question_id: str
    question: str
    category: str
    keywords: list[str]
    context: str
    hit: bool          # True if any keyword found in context (case-insensitive)
    latency_ms: float


@dataclass
class SystemResult:
    system_name: str
    ingest_total_ms: float
    flush_total_ms: float
    question_results: list[QuestionResult] = field(default_factory=list)
    error: Optional[str] = None

    @property
    def questions_answered(self) -> int:
        return sum(1 for r in self.question_results if r.hit)

    @property
    def total_questions(self) -> int:
        return len(self.question_results)

    @property
    def overall_score(self) -> float:
        return self.questions_answered / self.total_questions if self.total_questions else 0.0

    def score_for_category(self, category: str) -> tuple[int, int]:
        qs = [r for r in self.question_results if r.category == category]
        return (sum(1 for r in qs if r.hit), len(qs))

    @property
    def avg_search_latency_ms(self) -> float:
        lats = [r.latency_ms for r in self.question_results]
        return sum(lats) / len(lats) if lats else 0.0


# ---------------------------------------------------------------------------
# Scorer
# ---------------------------------------------------------------------------

def score_question(question: EvalQuestion, context: str) -> bool:
    """
    Keyword-based scoring: hit if the retrieved context contains at least one
    of the expected keywords (case-insensitive).

    This is deterministic and requires no external LLM call, so results are
    fully reproducible. The trade-off is that it rewards exact lexical match
    and can miss paraphrase. For a richer eval, replace with an LLM judge.
    """
    ctx_lower = context.lower()
    return any(kw.lower() in ctx_lower for kw in question.keywords)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_system(adapter, persona: dict, user_id: str) -> SystemResult:
    questions = [
        EvalQuestion(
            id=q["id"],
            question=q["question"],
            keywords=q["keywords"],
            category=q["category"],
        )
        for q in persona["eval_questions"]
    ]

    print(f"\n{'='*60}")
    print(f"  Running: {adapter.name}")
    print(f"{'='*60}")

    # --- Setup ---
    try:
        adapter.setup(user_id)
    except NotImplementedError as exc:
        return SystemResult(
            system_name=adapter.name,
            ingest_total_ms=0,
            flush_total_ms=0,
            error=str(exc),
        )
    except Exception as exc:
        return SystemResult(
            system_name=adapter.name,
            ingest_total_ms=0,
            flush_total_ms=0,
            error=f"setup() failed: {exc}",
        )

    # --- Ingest ---
    print(f"  Ingesting {sum(len(s['messages']) for s in persona['sessions'])} messages "
          f"across {len(persona['sessions'])} sessions…")

    ingest_start = time.monotonic()
    try:
        for session in persona["sessions"]:
            for msg in session["messages"]:
                if msg["role"] == "user":
                    adapter.ingest(msg["content"], session_id=session["id"])
    except Exception as exc:
        traceback.print_exc()
        adapter.teardown()
        return SystemResult(
            system_name=adapter.name,
            ingest_total_ms=0,
            flush_total_ms=0,
            error=f"ingest() failed: {exc}",
        )
    ingest_ms = (time.monotonic() - ingest_start) * 1000
    print(f"  ✓ Ingest done ({ingest_ms:.0f} ms)")

    # --- Flush ---
    print("  Flushing (waiting for indexing / compaction)…")
    flush_start = time.monotonic()
    try:
        adapter.flush()
    except Exception as exc:
        traceback.print_exc()
        adapter.teardown()
        return SystemResult(
            system_name=adapter.name,
            ingest_total_ms=ingest_ms,
            flush_total_ms=0,
            error=f"flush() failed: {exc}",
        )
    flush_ms = (time.monotonic() - flush_start) * 1000
    print(f"  ✓ Flush done ({flush_ms:.0f} ms)")

    # --- Evaluate ---
    print(f"  Evaluating {len(questions)} questions…")
    question_results: list[QuestionResult] = []

    for i, q in enumerate(questions):
        t0 = time.monotonic()
        try:
            context = adapter.search(q.question)
        except Exception as exc:
            context = ""
            print(f"    [WARN] search failed for {q.id}: {exc}")

        # Always show the raw context for the first question — cheapest way
        # to diagnose empty-block problems without a separate debug mode.
        if i == 0:
            print(f"    [sample] resultLen={len(context)}  "
                  f"preview={context[:120]!r}")
        latency_ms = (time.monotonic() - t0) * 1000

        hit = score_question(q, context)
        question_results.append(
            QuestionResult(
                question_id=q.id,
                question=q.question,
                category=q.category,
                keywords=q.keywords,
                context=context,
                hit=hit,
                latency_ms=latency_ms,
            )
        )
        print(f"    {'✓' if hit else '✗'} {q.id} ({q.category})  {latency_ms:.0f}ms")

    # --- Teardown ---
    try:
        adapter.teardown()
    except Exception:
        pass

    result = SystemResult(
        system_name=adapter.name,
        ingest_total_ms=ingest_ms,
        flush_total_ms=flush_ms,
        question_results=question_results,
    )

    print(f"\n  Score: {result.questions_answered}/{result.total_questions} "
          f"({result.overall_score:.0%})")
    return result


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

CATEGORIES = ["flat-recall", "relational", "temporal"]

def build_report(persona: dict, results: list[SystemResult]) -> str:
    lines: list[str] = []
    p = persona

    lines += [
        f"# Memory System Benchmark — {p['name']}",
        "",
        f"> Persona: **{p['name']}** — {p['description']}  ",
        f"> Questions: {len(p['eval_questions'])} across {len(CATEGORIES)} categories  ",
        f"> Scoring: keyword match (hit if ≥1 keyword found in retrieved context)  ",
        "",
    ]

    # --- Overall scores ---
    lines += ["## Overall Scores", ""]
    header = "| System | Score | flat-recall | relational | temporal | Ingest | Flush | Avg search |"
    sep    = "|--------|-------|-------------|------------|----------|--------|-------|------------|"
    lines += [header, sep]

    for r in results:
        if r.error:
            lines.append(f"| {r.system_name} | ERROR | — | — | — | — | — | — |")
            continue
        cats = {c: r.score_for_category(c) for c in CATEGORIES}
        def fmt(hit, tot): return f"{hit}/{tot}" if tot else "—"
        lines.append(
            f"| {r.system_name} "
            f"| **{r.questions_answered}/{r.total_questions}** ({r.overall_score:.0%}) "
            f"| {fmt(*cats['flat-recall'])} "
            f"| {fmt(*cats['relational'])} "
            f"| {fmt(*cats['temporal'])} "
            f"| {r.ingest_total_ms:.0f}ms "
            f"| {r.flush_total_ms:.0f}ms "
            f"| {r.avg_search_latency_ms:.0f}ms |"
        )

    lines += [""]

    # --- Per-question breakdown ---
    lines += ["## Per-Question Breakdown", ""]
    all_q_ids = [q["id"] for q in p["eval_questions"]]
    all_qs = {q["id"]: q for q in p["eval_questions"]}

    # Header row
    sys_names = [r.system_name for r in results]
    header = "| ID | Category | Question | " + " | ".join(sys_names) + " |"
    sep_cols = ["---"] * (3 + len(sys_names))
    lines += [header, "|" + "|".join(sep_cols) + "|"]

    for qid in all_q_ids:
        q = all_qs[qid]
        row = f"| {qid} | {q['category']} | {q['question'][:55]}… |"
        for r in results:
            if r.error:
                row += " — |"
                continue
            qr = next((x for x in r.question_results if x.question_id == qid), None)
            if qr is None:
                row += " — |"
            else:
                row += f" {'✓' if qr.hit else '✗'} |"
        lines.append(row)

    lines += [""]

    # --- Errors ---
    errors = [(r.system_name, r.error) for r in results if r.error]
    if errors:
        lines += ["## Errors", ""]
        for name, err in errors:
            lines += [f"**{name}**: `{err}`", ""]

    lines += [
        "---",
        "*Generated by `scripts/benchmark/benchmark.py`*",
        "",
    ]

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Head-to-head memory system benchmark")
    parser.add_argument(
        "--persona",
        default=str(Path(__file__).parent / "personas" / "jordan_rivera.json"),
        help="Path to persona JSON file",
    )
    parser.add_argument(
        "--systems",
        default="ci_server,mem0",
        help="Comma-separated list of systems to benchmark (ci_server, mem0, honcho)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Write Markdown report to this file (default: stdout)",
    )
    parser.add_argument(
        "--user-id",
        default="benchmark_user_001",
        help="Synthetic user ID — must exist in CI-Server for the API key to be valid",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Clear prior benchmark fragments and derived entities before running "
             "(CI-Server adapter only; uses docker exec into the postgres container).",
    )
    args = parser.parse_args()

    # Load persona
    persona_path = Path(args.persona)
    if not persona_path.exists():
        print(f"ERROR: persona file not found: {persona_path}", file=sys.stderr)
        sys.exit(1)
    persona = json.loads(persona_path.read_text())

    # Build adapter list
    from adapters import CIServerAdapter, Mem0Adapter, HonchoAdapter

    adapter_map = {
        "ci_server": CIServerAdapter,
        "mem0": Mem0Adapter,
        "honcho": HonchoAdapter,
    }

    system_names = [s.strip() for s in args.systems.split(",")]
    adapters = []
    for name in system_names:
        if name not in adapter_map:
            print(f"ERROR: unknown system '{name}'. Choose from: {', '.join(adapter_map)}", file=sys.stderr)
            sys.exit(1)
        if name == "ci_server":
            adapters.append(CIServerAdapter(reset=args.reset))
        else:
            adapters.append(adapter_map[name]())

    print(f"Benchmarking {len(adapters)} system(s) against persona: {persona['name']}")
    print(f"Questions: {len(persona['eval_questions'])}")

    # Run each system
    results = [run_system(adapter, persona, args.user_id) for adapter in adapters]

    # Build and output report
    report = build_report(persona, results)

    if args.out:
        Path(args.out).write_text(report, encoding="utf-8")
        print(f"\n✓ Report written to {args.out}")
    else:
        print("\n\n" + report)


if __name__ == "__main__":
    main()
