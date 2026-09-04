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
    run_system_repeated,
    score_keyword,
    validate_persona,
)
from .judge_cache import JudgeCache, cached_scorer
from .stats import describe


def _load_persona(path: Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    errors = validate_persona(data)
    if errors:
        print(f"[error] persona {path} is invalid:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(2)
    return data


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m benchmark", description="CI-Server memory benchmark"
    )
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
        "--judge-cache",
        type=Path,
        default=None,
        help="persist LLM-judge verdicts to this JSON file; identical (question, context, model)"
        " tuples are read from cache instead of re-queried",
    )
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
    p.add_argument(
        "--runs",
        type=int,
        default=1,
        help="repeat each adapter N times and aggregate (median/IQR/etc.) into the"
        " report; 1 = single-run, byte-identical to round-3 output",
    )
    args = p.parse_args(argv)
    if args.runs < 1 or args.runs > 50:
        print(
            f"[error] --runs must be between 1 and 50 (got {args.runs})",
            file=sys.stderr,
        )
        return 2

    persona = _load_persona(args.persona)

    names = [n.strip() for n in args.systems.split(",") if n.strip()]
    unknown = [n for n in names if n not in ADAPTERS]
    if unknown:
        print(f"[error] unknown adapter(s): {unknown}", file=sys.stderr)
        return 2
    adapters = [get_adapter(n) for n in names]

    judge_cache: JudgeCache | None = None
    if args.scorer == "llm":
        if not args.judge_url or not args.judge_model:
            print(
                "[error] --scorer llm requires --judge-url and --judge-model",
                file=sys.stderr,
            )
            return 2
        scorer = make_llm_scorer(args.judge_url, args.judge_model, args.judge_key)
        if args.judge_cache:
            judge_cache = JudgeCache.load(args.judge_cache)
            scorer = cached_scorer(scorer, judge_cache, model=args.judge_model)
    else:
        scorer = score_keyword
        if args.judge_cache:
            print(
                "[warn] --judge-cache is ignored when --scorer is not 'llm'",
                file=sys.stderr,
            )

    def _event(phase: str, system: str, payload: dict) -> None:
        if phase == "start":
            print(f"\n==> {system}")
        elif phase == "question":
            mark = "✓" if payload["hit"] else "✗"
            print(f"   {mark} {payload['id']} ({payload['latency_ms']:.0f} ms)")
        elif phase == "done":
            ratio = payload["score"]
            print(
                f"   score: {payload['score'] * payload['total']:.0f}/{payload['total']} ({ratio:.0%})"
            )
        elif phase == "error":
            print(
                f"   [ERROR @ {payload['phase']}]: {payload['error']}", file=sys.stderr
            )

    if args.runs == 1:
        results = run_all(adapters, persona, args.user_id, scorer, on_event=_event)
        report_input: object = results
        # Errors: any adapter erroring is a failure.
        any_error = any(r.error for r in results)
    else:
        multi: list = []
        for adapter in adapters:
            runs = run_system_repeated(
                adapter,
                persona,
                args.user_id,
                scorer,
                runs=args.runs,
                on_event=_event,
            )
            overalls = [r.overall_score for r in runs]
            searches = [r.avg_search_latency_ms for r in runs]
            d = describe(overalls)
            sd = describe(searches)
            median_pct = d.get("median", 0.0) * 100
            iqr_pp = d.get("iqr", 0.0) * 100
            print(
                f"   runs={len(runs)} median={median_pct:.0f}% iqr={iqr_pp:.0f}pp"
                f" median_search={sd.get('median', 0.0):.0f}ms"
            )
            multi.append(runs)
        report_input = multi
        # Errors: an adapter is "errored" only if every run errored.
        any_error = any(all(r.error for r in runs) for runs in multi if runs)

    if judge_cache is not None:
        judge_cache.save()
        print(
            f"\n[judge-cache] hits={judge_cache.hits} misses={judge_cache.misses} "
            f"entries={len(judge_cache)} ({judge_cache.path})"
        )

    md = build_markdown_report(persona, report_input, scorer_label=args.scorer)
    js = build_json_report(persona, report_input)

    if args.out:
        args.out.write_text(md, encoding="utf-8")
        args.out.with_suffix(".json").write_text(
            json.dumps(js, indent=2), encoding="utf-8"
        )
        print(f"\nReport: {args.out}")
        print(f"JSON:   {args.out.with_suffix('.json')}")
    else:
        print()
        print(md)

    exit_code = 0 if not any_error else 1

    # Regression gate: load the baseline, compare, and surface failures.
    if args.baseline:
        try:
            baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"[error] could not load baseline {args.baseline}: {exc}",
                file=sys.stderr,
            )
            return 2
        report = compare(baseline, js, tolerance=args.tolerance)
        print()
        print(format_summary(report))
        if not report.passed:
            exit_code = max(exit_code, 1)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
