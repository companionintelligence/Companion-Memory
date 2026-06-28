"""Command-line entry point.

Usage:
  python -m benchmark --persona personas/jordan_rivera.json --systems ci_server,naive
  python -m benchmark --persona ... --scorer llm --judge-url http://lm:1234 --judge-model qwen2.5-7b
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import (
    ADAPTERS,
    build_json_report,
    build_markdown_report,
    compare,
    format_summary,
    get_adapter,
    make_llm_scorer,
    run_all,
    score_keyword,
    validate_persona,
)


def _load_persona(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    errors = validate_persona(data)
    if errors:
        print(f"[error] persona {path} is invalid:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(2)
    return data


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m benchmark", description="CI-Server memory benchmark")
    p.add_argument("--persona", type=Path, required=True, help="persona JSON file")
    p.add_argument(
        "--systems",
        default="ci_server,naive",
        help=f"comma-separated adapter names (known: {','.join(sorted(ADAPTERS))})",
    )
    p.add_argument("--user-id", default="benchmark_user", help="synthetic user id")
    p.add_argument(
        "--out",
        type=Path,
        default=None,
        help="markdown report path (default: stdout). JSON written alongside as .json.",
    )
    p.add_argument("--scorer", choices=("keyword", "llm"), default="keyword")
    p.add_argument("--judge-url", default=os.environ.get("JUDGE_URL", ""))
    p.add_argument("--judge-model", default=os.environ.get("JUDGE_MODEL", ""))
    p.add_argument("--judge-key", default=os.environ.get("JUDGE_API_KEY", ""))
    p.add_argument(
        "--baseline",
        type=Path,
        default=None,
        help="prior JSON report to compare against; non-zero exit on regression",
    )
    p.add_argument(
        "--tolerance",
        type=float,
        default=0.05,
        help="regression tolerance in score-ratio units (default: 0.05 = 5pp)",
    )
    args = p.parse_args(argv)

    persona = _load_persona(args.persona)

    names = [n.strip() for n in args.systems.split(",") if n.strip()]
    unknown = [n for n in names if n not in ADAPTERS]
    if unknown:
        print(f"[error] unknown adapter(s): {unknown}", file=sys.stderr)
        return 2
    adapters = [get_adapter(n) for n in names]

    if args.scorer == "llm":
        if not args.judge_url or not args.judge_model:
            print("[error] --scorer llm requires --judge-url and --judge-model", file=sys.stderr)
            return 2
        scorer = make_llm_scorer(args.judge_url, args.judge_model, args.judge_key)
    else:
        scorer = score_keyword

    def _event(phase: str, system: str, payload: dict) -> None:
        if phase == "start":
            print(f"\n==> {system}")
        elif phase == "question":
            mark = "✓" if payload["hit"] else "✗"
            print(f"   {mark} {payload['id']} ({payload['latency_ms']:.0f} ms)")
        elif phase == "done":
            ratio = payload["score"]
            print(f"   score: {payload['score'] * payload['total']:.0f}/{payload['total']} ({ratio:.0%})")
        elif phase == "error":
            print(f"   [ERROR @ {payload['phase']}]: {payload['error']}", file=sys.stderr)

    results = run_all(adapters, persona, args.user_id, scorer, on_event=_event)

    md = build_markdown_report(persona, results, scorer_label=args.scorer)
    js = build_json_report(persona, results)

    if args.out:
        args.out.write_text(md, encoding="utf-8")
        args.out.with_suffix(".json").write_text(json.dumps(js, indent=2), encoding="utf-8")
        print(f"\nReport: {args.out}")
        print(f"JSON:   {args.out.with_suffix('.json')}")
    else:
        print()
        print(md)

    exit_code = 0 if all(not r.error for r in results) else 1

    # Regression gate: load the baseline, compare, and surface failures.
    if args.baseline:
        try:
            baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[error] could not load baseline {args.baseline}: {exc}", file=sys.stderr)
            return 2
        report = compare(baseline, js, tolerance=args.tolerance)
        print()
        print(format_summary(report))
        if not report.passed:
            exit_code = max(exit_code, 1)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
