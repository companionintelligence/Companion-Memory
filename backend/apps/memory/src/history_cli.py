"""Command line helper for browser-history processing."""
from __future__ import annotations

import argparse
from pathlib import Path

from .browser_history_processor import BrowserHistoryProcessor


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Summarize browser history CSV exports.")
    parser.add_argument(
        "--input",
        required=True,
        help="Path to the CSV export (e.g., data/history.csv).",
    )
    parser.add_argument(
        "--output",
        help="Optional output CSV path. Defaults to data/<source>_summaries_<timestamp>.csv",
    )
    parser.add_argument(
        "--disable-llm",
        action="store_true",
        help="Skip sending buckets to the LLM (offline/test mode).",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    processor = BrowserHistoryProcessor(enable_llm=not args.disable_llm)
    result = processor.process_csv_file(args.input, args.output)
    print(
        "Created {hourly} hourly and {daily} daily summaries at {path}".format(
            hourly=len(result["hourly"]),
            daily=len(result["daily"]),
            path=result["output_csv"],
        )
    )


if __name__ == "__main__":
    main()
