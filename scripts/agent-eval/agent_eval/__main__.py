"""Run or validate the multi-turn chat eval.

python -m agent_eval validate
python -m agent_eval run --out reports/latest.md
python -m agent_eval score path/to/trace.json path/to/case.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .chat import ChatClient
from .evaluate import evaluate_trace
from .report import render_markdown, summarize, write_report
from .runner import CaseRun, run_case
from .schema import Case, load_cases, validate_case
from .trace import ConversationTrace, ToolCall, TurnTrace


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent_eval")
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate", help="check case files and exit")
    _add_case_args(validate)

    run = sub.add_parser("run", help="play each conversation against the chat API")
    _add_case_args(run)
    run.add_argument("--out", type=Path, default=Path("reports/latest.md"))
    run.add_argument(
        "--score-incomplete",
        action="store_true",
        help="score cases marked needs_owner instead of skipping them",
    )
    run.add_argument("--model", default="")
    run.add_argument("--timeout", type=float, default=300.0)

    score = sub.add_parser("score", help="score a saved trace against its case")
    score.add_argument("trace", type=Path)
    score.add_argument("case", type=Path)

    args = parser.parse_args(argv)
    if args.command == "validate":
        return _validate(args)
    if args.command == "run":
        return _run(args)
    return _score(args)


def _add_case_args(parser: argparse.ArgumentParser) -> None:
    here = Path(__file__).resolve().parent.parent / "cases"
    parser.add_argument(
        "--cases",
        type=Path,
        action="append",
        default=[],
        help=f"case directory (repeatable). Default: {here}",
    )


def _case_dirs(args: argparse.Namespace) -> list[Path]:
    if args.cases:
        return args.cases
    return [Path(__file__).resolve().parent.parent / "cases"]


def _validate(args: argparse.Namespace) -> int:
    failed = False
    for directory in _case_dirs(args):
        cases, errors = load_cases(directory)
        for error in errors:
            print(error, file=sys.stderr)
            failed = True
        print(f"{directory}: {len(cases)} cases")
    return 1 if failed else 0


def _run(args: argparse.Namespace) -> int:
    cases: list[Case] = []
    errors: list[str] = []
    for directory in _case_dirs(args):
        loaded, found = load_cases(directory)
        cases.extend(loaded)
        errors.extend(found)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    if not cases:
        print("no cases found", file=sys.stderr)
        return 1
    client = ChatClient(model=args.model or None, timeout=args.timeout)
    runs = []
    for index, case in enumerate(cases, start=1):
        print(f"[{index}/{len(cases)}] {case.id}", flush=True)
        runs.append(run_case(case, client, score_incomplete=args.score_incomplete))
    summary = summarize(runs)
    write_report(summary, args.out)
    print(render_markdown(summary))
    print(f"wrote {args.out} and {args.out.with_suffix('.json')}")
    return 1 if any(run.failed() for run in runs) else 0


def _score(args: argparse.Namespace) -> int:
    raw_case = json.loads(args.case.read_text(encoding="utf-8"))
    problems = validate_case(raw_case)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1
    case = Case.from_dict(raw_case, source=str(args.case))
    raw_trace = json.loads(args.trace.read_text(encoding="utf-8"))
    trace = _trace_from_dict(raw_trace)
    run = CaseRun(case=case, trace=trace, checks=evaluate_trace(case, trace))
    summary = summarize([run])
    print(render_markdown(summary))
    return 1 if run.failed() else 0


def _trace_from_dict(raw: dict) -> ConversationTrace:
    turns: list[TurnTrace] = []
    for turn in raw.get("turns") or []:
        calls = [
            ToolCall(
                name=str(call.get("name") or ""),
                arguments=call.get("arguments") or {},
                result=str(call.get("result") or ""),
            )
            for call in turn.get("tool_calls") or []
        ]
        turns.append(
            TurnTrace(
                user=str(turn.get("user") or ""),
                assistant_text=str(turn.get("assistant_text") or ""),
                tool_calls=calls,
                tool_results=int(turn.get("tool_results") or len(calls)),
            )
        )
    return ConversationTrace(
        case_id=str(raw.get("case_id") or ""),
        thread_id=str(raw.get("thread_id") or ""),
        turns=turns,
        error=str(raw.get("error") or ""),
    )


if __name__ == "__main__":
    raise SystemExit(main())
