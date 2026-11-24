#!/usr/bin/env python3
"""Turns the bench's results-*.jsonl into tables.

    summarize.py results/results-think.jsonl --by carry,note
    summarize.py results/*.jsonl --by shaper,toolBudget --where maxTokens=1024
    summarize.py results/results-load.jsonl --load
    summarize.py results/results-think.jsonl --answers --where prompt=p3 --limit 12
    summarize.py results/*.jsonl --queries --by plan,prompt
    summarize.py results/*.jsonl --rooms

`plan` is also a field: the plan a result line came from (the `results-<plan>.jsonl` file name).

Rates are over the first question of each cell unless --turn says otherwise. `useful` means the answer
is non-empty, carries at least one of the prompt's facts, names nothing only a decoy hit contains, and
is clean (no control markers, no foreign-script letters, no runaway repetition): the first filter, not
a verdict. `--answers` prints the answers themselves so the filter can be checked by reading.
"""

import argparse
import collections
import glob
import json
import os
import re
import statistics
import sys

FACT_GROUPS = {"p1": 3, "p2": 3, "p3": 2}


def load(paths):
    rows = []
    for pattern in paths:
        for path in sorted(glob.glob(pattern)):
            with open(path) as handle:
                for line in handle:
                    line = line.strip()
                    if line:
                        row = json.loads(line)
                        row.setdefault(
                            "plan",
                            os.path.basename(path)[len("results-") : -len(".jsonl")],
                        )
                        rows.append(row)
    return rows


def field(row, name):
    """A cell field, or a field of the result line itself (`plan`)."""
    cell = row["cell"]

    return cell[name] if name in cell else row.get(name)


def matches(row, wheres):
    for key, want in wheres:
        got = field(row, key)
        if str(got).lower() != want.lower():
            return False
    return True


def med(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def fmt(value, digits=0):
    if value is None:
        return "-"
    return f"{value:.{digits}f}" if digits else str(round(value))


COUNTS = False


def pct(part, whole):
    if not whole:
        return "-"
    if COUNTS:
        return f"{part}/{whole}"
    return f"{round(100.0 * part / whole)}%"


def table(headers, rows):
    widths = [
        max(len(str(r[i])) for r in [headers, *rows]) for i in range(len(headers))
    ]

    def line(r):
        return (
            "| "
            + " | ".join(str(c).ljust(w) for c, w in zip(r, widths, strict=True))
            + " |"
        )

    print(line(headers))
    print("|" + "|".join("-" * (w + 2) for w in widths) + "|")
    for r in rows:
        print(line(r))


def group_key(row, fields):
    return tuple(str(field(row, f)) for f in fields)


def summarize(rows, fields, turn):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[group_key(row, fields)].append(row)

    out = []
    for key in sorted(groups):
        cells = groups[key]
        turns = [(c, c["turns"][turn]) for c in cells if len(c["turns"]) > turn]
        n = len(turns)
        useful = sum(1 for _, t in turns if t["score"]["useful"])
        grounded = sum(1 for _, t in turns if t["score"]["grounded"])
        full = sum(
            1
            for c, t in turns
            if t["score"]["groundedGroups"]
            >= FACT_GROUPS.get(c["cell"].get("prompt"), 1)
        )
        clean = sum(1 for _, t in turns if t["score"]["clean"])
        empty = sum(1 for _, t in turns if not t["score"]["nonEmpty"])
        wrong = sum(1 for _, t in turns if t["score"]["wrongHit"])
        errors = sum(1 for _, t in turns if t.get("error"))
        called = sum(1 for _, t in turns if t["toolCalls"])
        useful_called = sum(
            1 for _, t in turns if t["toolCalls"] and t["score"]["useful"]
        )
        out.append(
            [
                *list(key),
                n,
                pct(useful, n),
                pct(grounded, n),
                pct(full, n),
                pct(clean, n),
                pct(empty, n),
                pct(wrong, n),
                pct(called, n),
                pct(useful_called, called),
                fmt(med([t.get("answerTokens") for _, t in turns])),
                fmt(med([t.get("postToolFirstChunkMs") for _, t in turns])),
                fmt(med([t["totalMs"] for _, t in turns])),
                fmt(med([t.get("kvAfter") for _, t in turns])),
                errors,
            ]
        )
    return out


# Words that carry nothing to a keyword search: what is left of the user's request around the thing it asks
# about. A query containing one is the instruction (or the question) passed through, not key words.
FILLER_WORDS = {
    "a", "about", "an", "appointment", "do", "for", "i", "is", "know", "me", "memory", "my", "search",
    "tell", "the", "to", "what", "when",
}  # fmt: skip


def query_of(call):
    try:
        return str(json.loads(call["arguments"] or "{}").get("query", ""))
    except (ValueError, AttributeError):
        return ""


def show_queries(rows, fields):
    """What the model passes as `knowledge_search`'s query, counted by whether it is key words or the instruction."""
    groups = collections.defaultdict(list)
    for row in rows:
        for turn in row["turns"]:
            for call in turn["toolCalls"]:
                if call["tool"] == "knowledge_search":
                    groups[group_key(row, fields)].append(query_of(call))

    out = []
    for key in sorted(groups):
        queries = groups[key]
        filler = sum(
            1 for q in queries if FILLER_WORDS & set(re.findall(r"[a-z']+", q.lower()))
        )
        words = statistics.mean(len(q.split()) for q in queries)
        out.append([*key, len(queries), filler, len(queries) - filler, f"{words:.1f}"])

    table([*fields, "calls", "instruction", "key words", "mean words"], out)


def turn_ran_away(turn, window):
    """The reply is not clean (control markers, foreign script, runaway repetition) or went on until the window was full."""
    return (not turn["score"]["clean"]) or (turn.get("kvAfter") or 0) >= window - 8


def show_rooms(rows):
    """Tool turns by the room the window had left once the tool's result was in: window - (cache at the call +
    the result + the 18-token wrapper). The reply that follows a tool result comes out garbled below about 700
    tokens, whatever the window."""
    buckets = collections.defaultdict(lambda: [set(), 0, 0, 0])

    for row in rows:
        cell = row["cell"]
        window = cell.get("maxTokens")
        if (
            cell.get("mode") != "tool"
            or not cell.get("bindTools", True)
            or not window
            or not row["turns"]
        ):
            continue

        turn = row["turns"][0]
        calls = [
            c
            for c in turn["toolCalls"]
            if c["tool"] != "inject" and c.get("kvAtCall") is not None
        ]
        if not calls:
            continue

        room = window - (calls[-1]["kvAtCall"] + calls[-1]["shapedTokens"] + 18)
        bucket = buckets[room // 100 * 100]
        bucket[0].add(window)
        bucket[1] += 1
        bucket[2] += turn_ran_away(turn, window)
        bucket[3] += turn["score"]["useful"]

    out = []
    for low in sorted(buckets):
        windows, turns, ran_away, useful = buckets[low]
        out.append(
            [
                f"{low}..{low + 99}",
                ",".join(map(str, sorted(windows))),
                turns,
                ran_away,
                useful,
            ]
        )

    table(["room left (tokens)", "windows", "turns", "garbled", "useful"], out)


def show_load(rows):
    out = []
    for row in rows:
        load = row.get("load") or {}
        turn = row["turns"][0] if row["turns"] else {}
        out.append(
            [
                row["cell"]["id"][:48],
                row["cell"].get("model", ""),
                load.get("accelerator", "-"),
                row["cell"].get("maxTokens") or "def",
                row["status"],
                fmt(load.get("loadMs")),
                fmt(load.get("footprintAfterMB")),
                fmt(load.get("availableAfterMB")),
                fmt(turn.get("firstChunkMs")),
                fmt(turn.get("chunks")),
                fmt(turn.get("totalMs")),
                (row.get("error") or "")[:60],
            ]
        )
    table(
        [
            "cell",
            "model",
            "accel",
            "window",
            "status",
            "load ms",
            "footprint MB",
            "avail MB",
            "ttft ms",
            "chunks",
            "total ms",
            "error",
        ],
        out,
    )


def show_answers(rows, limit, turn):
    for row in rows[:limit]:
        if len(row["turns"]) <= turn:
            print(
                "== {}: {} {}".format(
                    row["cell"]["id"], row["status"], row.get("error") or ""
                )
            )
            continue
        t = row["turns"][turn]
        s = t["score"]
        print(
            f"== {row['cell']['id']}  [useful={s['useful']} grounded={s['groundedGroups']} "
            f"clean={s['clean']} wrong={s['wrongHit']} tokens={t['answerTokens']} kv={t['kvAfter']}]"
        )
        for call in t["toolCalls"]:
            print(
                f"   tool {call['tool']} {call['arguments']} raw={call['rawBytes']}B "
                f"shaped={call['shapedBytes']}B ({call['shapedTokens']} tok)"
            )
        if t.get("error"):
            print("   ERROR: {}".format(t["error"]))
        if t["thought"]:
            print("   thought: {}".format(t["thought"][:240].replace("\n", " ")))
        print(
            "   answer: {}".format(
                (t["answer"].strip().replace("\n", " ") or "(empty)")[:600]
            )
        )


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("paths", nargs="+")
    parser.add_argument(
        "--by",
        default="note,toolBudget",
        help="comma-separated cell fields to group by",
    )
    parser.add_argument(
        "--where", action="append", default=[], help="field=value filter, repeatable"
    )
    parser.add_argument("--turn", type=int, default=0)
    parser.add_argument(
        "--load",
        action="store_true",
        help="one line per cell: load time, memory, first-token time",
    )
    parser.add_argument("--answers", action="store_true", help="print the answers")
    parser.add_argument(
        "--rooms",
        action="store_true",
        help="tool turns by the room the window had left once the result was in, and how many came out garbled",
    )
    parser.add_argument(
        "--queries",
        action="store_true",
        help="what the model passes to knowledge_search, as key words or as the instruction",
    )
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument(
        "--counts", action="store_true", help="show rates as k/n instead of percentages"
    )
    args = parser.parse_args()

    global COUNTS
    COUNTS = args.counts

    rows = load(args.paths)
    wheres = [tuple(w.split("=", 1)) for w in args.where]
    rows = [r for r in rows if matches(r, wheres)]

    if not rows:
        print("no results", file=sys.stderr)
        return 1
    if args.load:
        show_load(rows)
        return 0
    if args.answers:
        show_answers(rows, args.limit, args.turn)
        return 0

    fields = [f for f in args.by.split(",") if f]
    if args.queries:
        show_queries(rows, fields)
        return 0
    if args.rooms:
        show_rooms(rows)
        return 0

    headers = [
        *fields,
        "n",
        "useful",
        "grounded",
        "all facts",
        "clean",
        "empty",
        "decoy",
        "tool called",
        "useful given called",
        "answer tok",
        "post-tool ms",
        "total ms",
        "kv tokens",
        "errors",
    ]
    table(headers, summarize(rows, fields, args.turn))
    return 0


if __name__ == "__main__":
    sys.exit(main())
