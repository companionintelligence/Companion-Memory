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
    answer: str = ""   # gold answer, used by the LLM judge (optional for keyword scorer)


@dataclass
class QuestionResult:
    question_id: str
    question: str
    category: str
    keywords: list[str]
    context: str
    hit: bool          # True if the scorer judged the context sufficient
    latency_ms: float
    reason: str = ""   # LLM-judge rationale (empty for keyword scorer)


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
# Scorers
#
# A scorer is a callable (question, context) -> (hit: bool, reason: str).
#
# keyword — deterministic lexical overlap. Fast and reproducible, but it
#   rewards verbatim text (a raw-chunk dump trivially "wins") and punishes any
#   system that normalizes or paraphrases. Good for regression, bad for
#   cross-architecture comparison.
#
# llm     — an LLM judge decides whether the retrieved context actually lets
#   you answer the question, given a gold answer. Credits correct paraphrase,
#   penalizes ambiguous/contradictory dumps, and is the fair way to compare
#   extraction-based memory against raw retrieval.
# ---------------------------------------------------------------------------

def score_keyword(question: EvalQuestion, context: str) -> tuple[bool, str]:
    ctx_lower = context.lower()
    hit = any(kw.lower() in ctx_lower for kw in question.keywords)
    return hit, ""


JUDGE_SYSTEM_PROMPT = (
    "You grade an AI memory system. You are given a QUESTION, the GOLD ANSWER, "
    "and the CONTEXT that a memory system retrieved. Decide whether the CONTEXT "
    "contains enough information to answer the QUESTION correctly.\n"
    "Rules:\n"
    "- The CONTEXT is drawn from a SINGLE person's personal memory store. That "
    "person is the subject of the QUESTION. So 'the user', 'the narrator', 'I', "
    "and the subject's own name all refer to the SAME person — treat a fact about "
    "'the user' as a fact about the person the question asks about. Do NOT mark "
    "something wrong merely because it says 'the user' instead of the name.\n"
    "- correct=true only if the CONTEXT states or directly implies the GOLD ANSWER. "
    "Paraphrases and synonyms count.\n"
    "- If the CONTEXT lacks the answer, correct=false.\n"
    "- For questions about the CURRENT state of something that changed over time, "
    "correct=true only if the CONTEXT makes the current/latest value identifiable; "
    "if it dumps both old and new values with no way to tell which is current, "
    "correct=false.\n"
    "- Judge only what the CONTEXT supports — do not use outside knowledge."
)

_JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "correct": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["correct", "reason"],
    "additionalProperties": False,
}


def make_llm_scorer(base_url: str, model: str, api_key: str, timeout: float = 120.0):
    """Build an LLM-judge scorer bound to an OpenAI-compatible endpoint."""
    import urllib.request as _u
    import urllib.error as _ue

    chat_url = f"{base_url.rstrip('/')}/v1/chat/completions"

    def score(question: EvalQuestion, context: str) -> tuple[bool, str]:
        if not context.strip():
            return False, "empty context"

        user_msg = (
            f"QUESTION: {question.question}\n"
            f"GOLD ANSWER: {question.answer or ', '.join(question.keywords)}\n"
            f"CONTEXT:\n{context}"
        )
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            "temperature": 0,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "verdict", "strict": True, "schema": _JUDGE_SCHEMA},
            },
        }
        data = json.dumps(payload).encode()
        req = _u.Request(chat_url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if api_key:
            req.add_header("Authorization", f"Bearer {api_key}")
        try:
            with _u.urlopen(req, timeout=timeout) as r:
                resp = json.loads(r.read())
            msg = resp.get("choices", [{}])[0].get("message", {})
            content = msg.get("content") or msg.get("reasoning_content") or ""
            verdict = json.loads(content)
            return bool(verdict.get("correct")), str(verdict.get("reason", ""))
        except Exception as exc:  # noqa: BLE001
            return False, f"judge error: {exc}"

    return score


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_system(adapter, persona: dict, user_id: str, scorer) -> SystemResult:
    questions = [
        EvalQuestion(
            id=q["id"],
            question=q["question"],
            keywords=q["keywords"],
            category=q["category"],
            answer=q.get("answer", ""),
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

        hit, reason = scorer(q, context)
        question_results.append(
            QuestionResult(
                question_id=q.id,
                question=q.question,
                category=q.category,
                keywords=q.keywords,
                context=context,
                hit=hit,
                latency_ms=latency_ms,
                reason=reason,
            )
        )
        suffix = f"  — {reason}" if (reason and not hit) else ""
        print(f"    {'✓' if hit else '✗'} {q.id} ({q.category})  {latency_ms:.0f}ms{suffix}")

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

def build_report(persona: dict, results: list[SystemResult], scorer_label: str = "keyword") -> str:
    lines: list[str] = []
    p = persona

    # Derive category set from the persona (preserve first-seen order) so new
    # categories like 'multi-hop' / 'temporal-update' appear without code edits.
    categories: list[str] = []
    for q in p["eval_questions"]:
        if q["category"] not in categories:
            categories.append(q["category"])
    if not categories:
        categories = list(CATEGORIES)

    scoring_desc = {
        "keyword": "keyword match (hit if ≥1 keyword found in retrieved context)",
        "llm": "LLM judge (hit if retrieved context supports the gold answer)",
    }.get(scorer_label, scorer_label)

    lines += [
        f"# Memory System Benchmark — {p['name']}",
        "",
        f"> Persona: **{p['name']}** — {p['description']}  ",
        f"> Questions: {len(p['eval_questions'])} across {len(categories)} categories  ",
        f"> Scoring: {scoring_desc}  ",
        "",
    ]

    # --- Overall scores ---
    lines += ["## Overall Scores", ""]
    cat_headers = " | ".join(categories)
    header = f"| System | Score | {cat_headers} | Ingest | Flush | Avg search |"
    sep = "|" + "|".join(["---"] * (5 + len(categories))) + "|"
    lines += [header, sep]

    def fmt(hit, tot):
        return f"{hit}/{tot}" if tot else "—"

    for r in results:
        if r.error:
            dashes = " | ".join(["—"] * len(categories))
            lines.append(f"| {r.system_name} | ERROR | {dashes} | — | — | — |")
            continue
        cats = {c: r.score_for_category(c) for c in categories}
        cat_cells = " | ".join(fmt(*cats[c]) for c in categories)
        lines.append(
            f"| {r.system_name} "
            f"| **{r.questions_answered}/{r.total_questions}** ({r.overall_score:.0%}) "
            f"| {cat_cells} "
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
    parser.add_argument(
        "--scorer",
        choices=["keyword", "llm"],
        default="keyword",
        help="Scoring method. 'keyword' = lexical overlap (fast, reproducible, but "
             "rewards raw-text dumps). 'llm' = an LLM judge decides if the retrieved "
             "context answers the question given a gold answer (fair across architectures).",
    )
    parser.add_argument(
        "--judge-url",
        default=os.environ.get("JUDGE_LLM_URL", "http://192.168.0.202:1234"),
        help="OpenAI-compatible base URL for the LLM judge (default: $JUDGE_LLM_URL or LM Studio).",
    )
    parser.add_argument(
        "--judge-model",
        default=os.environ.get("JUDGE_LLM_MODEL", "gemma-4-31b-it-abliterated"),
        help="Model id for the LLM judge (default: $JUDGE_LLM_MODEL).",
    )
    args = parser.parse_args()

    # Build the scorer
    if args.scorer == "llm":
        scorer = make_llm_scorer(
            base_url=args.judge_url,
            model=args.judge_model,
            api_key=os.environ.get("JUDGE_LLM_API_KEY", "lm-studio"),
        )
        print(f"Scorer: LLM judge ({args.judge_model} @ {args.judge_url})")
    else:
        scorer = score_keyword
        print("Scorer: keyword overlap")

    # Load persona
    persona_path = Path(args.persona)
    if not persona_path.exists():
        print(f"ERROR: persona file not found: {persona_path}", file=sys.stderr)
        sys.exit(1)
    persona = json.loads(persona_path.read_text())

    # Build adapter list
    from adapters import (
        CIServerAdapter,
        Mem0Adapter,
        NaiveRagAdapter,
        HindsightAdapter,
        HonchoAdapter,
    )

    adapter_map = {
        "ci_server": CIServerAdapter,
        "mem0": Mem0Adapter,
        "naive": NaiveRagAdapter,
        "hindsight": HindsightAdapter,
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
    results = [run_system(adapter, persona, args.user_id, scorer) for adapter in adapters]

    # Build and output report
    report = build_report(persona, results, scorer_label=args.scorer)

    if args.out:
        Path(args.out).write_text(report, encoding="utf-8")
        print(f"\n✓ Report written to {args.out}")
    else:
        print("\n\n" + report)


if __name__ == "__main__":
    main()
