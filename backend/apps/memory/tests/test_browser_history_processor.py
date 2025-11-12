"""Tests for the browser history processor."""
from pathlib import Path
import csv

from src.browser_history_processor import BrowserHistoryProcessor


def _sample_rows():
    return [
        {
            "date": "11/09/2025",
            "time": "08:00:00",
            "title": "CompInt Docs",
            "url": "https://compint.ai/docs",
            "visitCount": "2",
            "typedCount": "1",
            "transition": "typed",
        },
        {
            "date": "11/09/2025",
            "time": "08:15:00",
            "title": "CompInt Dashboard",
            "url": "https://compint.ai/dashboard",
            "visitCount": "1",
            "typedCount": "0",
            "transition": "link",
        },
        {
            "date": "11/09/2025",
            "time": "09:05:00",
            "title": "News",
            "url": "https://news.example.com/article",
            "visitCount": "3",
            "typedCount": "0",
            "transition": "link",
        },
    ]


def test_process_entries_produces_hourly_and_daily(tmp_path):
    processor = BrowserHistoryProcessor(output_dir=tmp_path, enable_llm=False)
    output_file = tmp_path / "history_summaries.csv"

    result = processor.process_entries(_sample_rows(), output_path=output_file)

    assert len(result["hourly"]) == 2
    assert len(result["daily"]) == 1
    assert Path(result["output_csv"]).exists()

    with open(result["output_csv"], newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)

    assert rows[0]["level"] == "hourly"
    assert rows[-1]["level"] == "daily"
    assert any("CompInt" in row["summary_text"] for row in rows)
