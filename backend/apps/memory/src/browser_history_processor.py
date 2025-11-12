"""Browser history ingestion and summarization utilities."""
from __future__ import annotations

import csv
import io
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, TextIO
from urllib.parse import urlparse

import structlog
from dateutil import parser as date_parser

from .summarizer import summarizer as llm_summarizer


logger = structlog.get_logger()


class BrowserHistoryProcessor:
    """Parse browser-history exports into hourly and daily summaries."""

    def __init__(
        self,
        output_dir: str | os.PathLike[str] = "data",
        enable_llm: bool = True,
    ):
        self.output_dir = Path(output_dir)
        self._llm_enabled = enable_llm
        self._llm = llm_summarizer if enable_llm else None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def process_csv_file(
        self,
        input_path: str | os.PathLike[str],
        output_path: Optional[str | os.PathLike[str]] = None,
    ) -> Dict[str, Any]:
        """Process a CSV file on disk."""
        logger.info("processing_browser_history_file", path=str(input_path))
        with open(input_path, "r", encoding="utf-8-sig", newline="") as handle:
            return self._process_reader(handle, output_path, source_name=Path(input_path).name)

    def process_csv_bytes(
        self,
        data: bytes,
        output_path: Optional[str | os.PathLike[str]] = None,
        source_name: str = "upload.csv",
    ) -> Dict[str, Any]:
        """Process a CSV payload that was uploaded via HTTP."""
        text = data.decode("utf-8-sig")
        buffer = io.StringIO(text)
        return self._process_reader(buffer, output_path, source_name=source_name)

    def process_entries(
        self,
        rows: Iterable[Dict[str, Any]],
        output_path: Optional[str | os.PathLike[str]] = None,
        source_name: str = "payload",
    ) -> Dict[str, Any]:
        """Process in-memory entries (used by tests and manual triggers)."""
        normalized = self._normalize_rows(rows)
        return self._finalize(normalized, output_path, source_name)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _process_reader(
        self,
        file_obj: TextIO,
        output_path: Optional[str | os.PathLike[str]],
        source_name: str,
    ) -> Dict[str, Any]:
        reader = csv.DictReader(file_obj)
        normalized = self._normalize_rows(reader)
        return self._finalize(normalized, output_path, source_name)

    def _normalize_rows(self, rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for row in rows:
            cleaned = self._normalize_row(row)
            if cleaned:
                normalized.append(cleaned)
        if not normalized:
            raise ValueError("No valid browser history rows found in payload")
        return normalized

    def _normalize_row(self, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        def clean_key(key: Optional[str]) -> str:
            key = key or ""
            return key.strip().lstrip("\ufeff").lower()

        cleaned = {clean_key(k): (v or "").strip() for k, v in row.items()}
        date_part = cleaned.get("date") or cleaned.get("last_visit_date")
        time_part = cleaned.get("time") or cleaned.get("last_visit_time")

        if not date_part or not time_part:
            logger.warning("history_row_missing_datetime", row=row)
            return None

        try:
            timestamp = date_parser.parse(f"{date_part} {time_part}")
        except (ValueError, TypeError) as exc:
            logger.warning("history_row_parse_failed", row=row, error=str(exc))
            return None

        url = cleaned.get("url", "")
        parsed = urlparse(url)
        domain = (parsed.netloc or "").lower()
        domain = domain[4:] if domain.startswith("www.") else domain

        visit_count = self._safe_int(cleaned.get("visitcount"), default=1)
        typed_count = self._safe_int(cleaned.get("typedcount"), default=0)
        transition = cleaned.get("transition") or "unknown"

        return {
            "timestamp": timestamp,
            "title": cleaned.get("title", ""),
            "url": url,
            "domain": domain,
            "visit_count": visit_count,
            "typed_count": typed_count,
            "transition": transition,
        }

    @staticmethod
    def _safe_int(value: Optional[str], default: int = 0) -> int:
        try:
            return int(value) if value not in ("", None) else default
        except ValueError:
            return default

    def _finalize(
        self,
        entries: List[Dict[str, Any]],
        output_path: Optional[str | os.PathLike[str]],
        source_name: str,
    ) -> Dict[str, Any]:
        hourly = self._summaries_for_granularity(entries, "hour")
        daily = self._summaries_for_granularity(entries, "day")

        csv_path = self._write_output(hourly, daily, output_path, source_name)

        logger.info(
            "browser_history_summaries_created",
            hourly=len(hourly),
            daily=len(daily),
            output=str(csv_path),
        )

        return {
            "hourly": hourly,
            "daily": daily,
            "output_csv": str(csv_path),
        }

    def _summaries_for_granularity(
        self, entries: List[Dict[str, Any]], granularity: str
    ) -> List[Dict[str, Any]]:
        buckets: Dict[datetime, List[Dict[str, Any]]] = defaultdict(list)

        for entry in entries:
            timestamp = entry["timestamp"]
            if granularity == "hour":
                bucket_key = timestamp.replace(minute=0, second=0, microsecond=0)
                bucket_end = bucket_key + timedelta(hours=1)
            elif granularity == "day":
                bucket_key = datetime(timestamp.year, timestamp.month, timestamp.day)
                bucket_end = bucket_key + timedelta(days=1)
            else:
                raise ValueError(f"Unsupported granularity: {granularity}")

            entry_copy = dict(entry)
            entry_copy["bucket_start"] = bucket_key
            entry_copy["bucket_end"] = bucket_end
            buckets[bucket_key].append(entry_copy)

        summaries: List[Dict[str, Any]] = []
        for start_time in sorted(buckets.keys()):
            bucket_entries = buckets[start_time]
            end_time = bucket_entries[0]["bucket_end"]
            summaries.append(self._summarize_bucket(bucket_entries, start_time, end_time, granularity))

        return summaries

    def _summarize_bucket(
        self,
        entries: List[Dict[str, Any]],
        start_time: datetime,
        end_time: datetime,
        granularity: str,
    ) -> Dict[str, Any]:
        total_entries = len(entries)
        total_visit_count = sum(max(1, e["visit_count"]) for e in entries)
        typed_visits = sum(max(0, e["typed_count"]) for e in entries)
        domains = [e["domain"] for e in entries if e["domain"]]
        titles = [e["title"] for e in entries if e["title"]]
        transitions = [e["transition"] for e in entries if e["transition"]]

        domain_counter = Counter(domains)
        title_counter = Counter(titles)
        transition_counter = Counter(transitions)

        stats = {
            "total_entries": total_entries,
            "total_visit_count": total_visit_count,
            "typed_visits": typed_visits,
            "unique_domains": len(domain_counter),
            "top_domains": self._format_counter(domain_counter),
            "top_titles": self._format_counter(title_counter),
            "top_transitions": self._format_counter(transition_counter),
        }

        summary_text = self._generate_llm_summary(
            granularity,
            start_time,
            end_time,
            stats,
            entries,
        )
        if not summary_text:
            summary_text = self._build_summary_text(
                granularity,
                start_time,
                total_entries,
                len(domain_counter),
                domain_counter,
            )

        return {
            "level": "hourly" if granularity == "hour" else "daily",
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "total_entries": total_entries,
            "total_visit_count": total_visit_count,
            "typed_visits": typed_visits,
            "unique_domains": len(domain_counter),
            "top_domains": stats["top_domains"],
            "top_titles": stats["top_titles"],
            "top_transitions": stats["top_transitions"],
            "summary_text": summary_text,
        }

    def _generate_llm_summary(
        self,
        granularity: str,
        start_time: datetime,
        end_time: datetime,
        stats: Dict[str, Any],
        entries: List[Dict[str, Any]],
    ) -> str:
        if not self._llm:
            return ""
        try:
            return self._llm.generate_history_summary(
                level="hourly" if granularity == "hour" else "daily",
                start_time=start_time,
                end_time=end_time,
                stats=stats,
                sample_entries=entries,
            )
        except Exception as exc:
            logger.warning("llm_history_summary_failed", error=str(exc))
            return ""

    def _build_summary_text(
        self,
        granularity: str,
        start_time: datetime,
        total_entries: int,
        unique_domains: int,
        domain_counter: Counter,
    ) -> str:
        window = "hour" if granularity == "hour" else "day"
        leaders = ", ".join([domain for domain, _ in domain_counter.most_common(3)])
        leaders = leaders or "(no domains captured)"
        return (
            f"During the {window} starting {start_time:%Y-%m-%d %H:%M}, "
            f"{total_entries} history entries were recorded across {unique_domains} domains. "
            f"Top domains: {leaders}."
        )

    @staticmethod
    def _format_counter(counter: Counter) -> str:
        return " | ".join([f"{item} ({count})" for item, count in counter.most_common(3)])

    def _write_output(
        self,
        hourly: List[Dict[str, Any]],
        daily: List[Dict[str, Any]],
        output_path: Optional[str | os.PathLike[str]],
        source_name: str,
    ) -> Path:
        if output_path:
            csv_path = Path(output_path)
        else:
            safe_name = Path(source_name).stem or "history"
            timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
            csv_path = self.output_dir / f"{safe_name}_summaries_{timestamp}.csv"

        csv_path.parent.mkdir(parents=True, exist_ok=True)

        fieldnames = [
            "level",
            "start_time",
            "end_time",
            "total_entries",
            "total_visit_count",
            "typed_visits",
            "unique_domains",
            "top_domains",
            "top_titles",
            "top_transitions",
            "summary_text",
        ]

        with open(csv_path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for row in hourly + daily:
                writer.writerow(row)

        return csv_path


# Shared instance for convenience
history_processor = BrowserHistoryProcessor()


__all__ = ["BrowserHistoryProcessor", "history_processor"]
