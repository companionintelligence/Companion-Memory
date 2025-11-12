"""PgBoss-backed summary worker that consumes scheduled jobs."""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Set

import structlog
from sqlalchemy import text

from .agent_registration import agent_registration
from .config import settings
from .data_aggregator import aggregator
from .database import db
from .storage import storage, SummaryMetadata
from .summarizer import summarizer

logger = structlog.get_logger()


@dataclass
class JobSchema:
    priority: str
    start_after: str
    created_on: str
    started_on: str
    completed_on: str
    state: str
    data: str
    output: Optional[str]

class SummaryWorker:
    """Fetches summary jobs from PgBoss and executes them."""

    def __init__(self):
        self.running = False
        self.job_schema = self._detect_job_schema()

    def start(self):
        self.running = True
        logger.info(
            "summary_worker_started",
            queue=settings.summary_queue_name,
            batch_size=settings.queue_fetch_batch_size,
        )

        while self.running:
            jobs = self._fetch_jobs()

            if not jobs:
                time.sleep(settings.queue_empty_backoff_seconds)
                continue

            for job in jobs:
                self._handle_job(job)

    def stop(self):
        self.running = False
        logger.info("summary_worker_stopped")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _fetch_jobs(self) -> list[Dict[str, Any]]:
        try:
            sql = self._build_fetch_sql()
            return db.execute_query(
                sql,
                {
                    "queue_name": settings.summary_queue_name,
                    "batch_size": settings.queue_fetch_batch_size,
                },
            )
        except Exception as exc:
            logger.error(
                "queue_fetch_failed",
                error=str(exc),
                queue=settings.summary_queue_name,
            )
            time.sleep(settings.queue_error_backoff_seconds)
            return []

    def _handle_job(self, job: Dict[str, Any]):
        job_id = job.get("id")
        if not job_id:
            logger.error("job_missing_id", job=job)
            return

        job_id_str = str(job_id)
        start_exec = time.time()

        message_id: Optional[uuid.UUID] = None

        try:
            payload = job.get("data") or job.get('DATA')
            if isinstance(payload, str):
                payload = json.loads(payload)

            if not isinstance(payload, dict):
                raise ValueError("Job payload must be a JSON object")

            user_id = uuid.UUID(payload.get("userId"))
            period_type = (payload.get("periodType") or "").lower()
            start_time = self._parse_iso(payload.get("periodStart"))
            end_time = self._parse_iso(payload.get("periodEnd"))
            timezone = payload.get("timezone") or "UTC"

            if period_type not in {"hourly", "daily", "weekly"}:
                raise NotImplementedError(f"Unsupported period type: {period_type}")

            message_id = self._record_agent_task(
                user_id=user_id,
                period_type=period_type,
                start_time=start_time,
                end_time=end_time,
                job_id=job_id_str,
                payload=payload,
            )

            logger.info(
                "processing_summary_job",
                job_id=job_id,
                user_id=str(user_id),
                period_type=period_type,
            )

            if period_type == "hourly":
                result = self._execute_hourly_summary(user_id, start_time, end_time, timezone)
            elif period_type == "daily":
                result = self._execute_daily_summary(user_id, start_time, end_time, timezone)
            elif period_type == "weekly":
                result = self._execute_weekly_summary(user_id, start_time, end_time, timezone)
            elif period_type == "monthly":
                result = self._execute_rollup_summary(user_id, start_time, end_time, timezone, 'monthly')
            elif period_type == "seasonal":
                result = self._execute_rollup_summary(user_id, start_time, end_time, timezone, 'seasonal')
            elif period_type == "yearly":
                result = self._execute_rollup_summary(user_id, start_time, end_time, timezone, 'yearly')
            else:
                raise NotImplementedError(f"Unsupported period type: {period_type}")

            execution_time_ms = int((time.time() - start_exec) * 1000)
            result["agent_message_id"] = str(message_id)
            self._complete_agent_message(message_id, result, job_id_str)
            self._complete_job(job_id_str, result)
            agent_registration.update_metrics(success=True, execution_time_ms=execution_time_ms)

            logger.info(
                "summary_job_completed",
                job_id=job_id,
                user_id=str(user_id),
                period_type=period_type,
                execution_time_ms=execution_time_ms,
            )
        except Exception as exc:
            execution_time_ms = int((time.time() - start_exec) * 1000)
            logger.error("summary_job_failed", job_id=job_id_str, error=str(exc))
            if message_id:
                self._fail_agent_message(message_id, str(exc), job_id_str)
            self._fail_job(job_id_str, str(exc))
            agent_registration.update_metrics(success=False, execution_time_ms=execution_time_ms)

    def _complete_job(self, job_id: str, output_payload: Dict[str, Any]):
        set_clauses = [f"{self.job_schema.state} = 'completed'", f"{self.job_schema.completed_on} = NOW()"]
        params = {"job_id": str(job_id)}
        if self.job_schema.output:
            set_clauses.append(f"{self.job_schema.output} = CAST(:output AS jsonb)")
            params["output"] = json.dumps(output_payload, default=self._json_default)

        db.execute_write(
            f"""
            UPDATE pgboss.job
            SET {', '.join(set_clauses)}
            WHERE id = :job_id
            """,
            params,
        )

    def _fail_job(self, job_id: str, reason: str):
        set_clauses = [f"{self.job_schema.state} = 'failed'"]
        params = {"job_id": str(job_id)}
        if self.job_schema.output:
            set_clauses.append(f"{self.job_schema.output} = CAST(:output AS jsonb)")
            params["output"] = json.dumps({"error": reason}, default=self._json_default)

        db.execute_write(
            f"""
            UPDATE pgboss.job
            SET {', '.join(set_clauses)}
            WHERE id = :job_id
            """,
            params,
        )

    def _record_agent_task(
        self,
        user_id: uuid.UUID,
        period_type: str,
        start_time: datetime,
        end_time: datetime,
        job_id: str,
        payload: Dict[str, Any],
    ) -> uuid.UUID:
        if not agent_registration.agent_id:
            raise RuntimeError("Agent is not registered; cannot record task")

        message_id = uuid.uuid4()
        goal_description = (
            f"{period_type.title()} summary for {start_time.isoformat()} to {end_time.isoformat()}"
        )

        enriched_payload = dict(payload)
        enriched_payload.setdefault("jobId", job_id)
        enriched_payload.setdefault("sourceQueue", settings.summary_queue_name)

        execution_context = {
            "pgboss_job_id": job_id,
            "queue": settings.summary_queue_name,
            "period_type": period_type,
        }

        db.execute_write(
            """
            INSERT INTO agent_messages (
                message_id,
                user_id,
                agent_id,
                root_message_id,
                input_payload,
                status,
                priority,
                created_at,
                started_at,
                execution_context,
                goal_description,
                execution_log
            ) VALUES (
                :message_id,
                :user_id,
                :agent_id,
                :root_message_id,
                CAST(:input_payload AS jsonb),
                'running',
                :priority,
                NOW(),
                NOW(),
                CAST(:execution_context AS jsonb),
                :goal_description,
                jsonb_build_array(
                    jsonb_build_object(
                        'event', 'started',
                        'timestamp', NOW(),
                        'job_id', :job_id,
                        'queue', :queue
                    )
                )
            )
            """,
            {
                "message_id": str(message_id),
                "user_id": str(user_id),
                "agent_id": str(agent_registration.agent_id),
                "root_message_id": str(message_id),
                "input_payload": json.dumps(enriched_payload, default=self._json_default),
                "priority": 5,
                "execution_context": json.dumps(execution_context, default=self._json_default),
                "goal_description": goal_description,
                "job_id": job_id,
                "queue": settings.summary_queue_name,
            },
        )

        return message_id

    def _complete_agent_message(
        self,
        message_id: uuid.UUID,
        output_payload: Dict[str, Any],
        job_id: str,
    ):
        db.execute_write(
            """
            UPDATE agent_messages
            SET status = 'completed',
                completed_at = NOW(),
                output_payload = :output::jsonb,
                execution_log = COALESCE(execution_log, '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object(
                        'event', 'completed',
                        'timestamp', NOW(),
                        'job_id', :job_id
                    )
                )
            WHERE message_id = :message_id
            """,
            {
                "message_id": str(message_id),
                "output": json.dumps(output_payload),
                "job_id": job_id,
            },
        )

    def _fail_agent_message(self, message_id: uuid.UUID, error_message: str, job_id: Optional[str]):
        db.execute_write(
            """
            UPDATE agent_messages
            SET status = 'failed',
                completed_at = NOW(),
                error_message = :error_message,
                output_payload = :output::jsonb,
                execution_log = COALESCE(execution_log, '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object(
                        'event', 'failed',
                        'timestamp', NOW(),
                        'job_id', :job_id,
                        'error', :error_message
                    )
                )
            WHERE message_id = :message_id
            """,
            {
                "message_id": str(message_id),
                "error_message": error_message,
                "output": json.dumps({"error": error_message}, default=self._json_default),
                "job_id": job_id,
            },
        )

    def _parse_iso(self, iso_str: str | None) -> datetime:
        if not iso_str:
            raise ValueError("Missing ISO timestamp in job payload")
        if iso_str.endswith("Z"):
            iso_str = iso_str.replace("Z", "+00:00")
        return datetime.fromisoformat(iso_str)

    # ------------------------------------------------------------------
    # Summary execution helpers (copied from legacy message listener)
    # ------------------------------------------------------------------
    def _execute_hourly_summary(
        self,
        user_id: uuid.UUID,
        start_time: datetime,
        end_time: datetime,
        timezone: str,
    ) -> Dict[str, Any]:
        logger.info("executing_hourly_summary", user_id=str(user_id))

        overlap = timedelta(minutes=settings.summary_overlap_minutes)
        adjusted_start = start_time - overlap
        adjusted_end = end_time + overlap

        aggregated_data = aggregator.aggregate_hour(user_id, adjusted_start, adjusted_end)
        summary_data = summarizer.generate_hourly_summary(aggregated_data)

        metadata = SummaryMetadata(
            timezone=timezone,
            source_types=self._derive_source_types(aggregated_data),
            structured_context={
                "activity_counts": summary_data['activity_counts'],
                "aggregated_data": aggregated_data,
                "key_insights": summary_data.get('key_insights'),
                "notable_events": summary_data.get('notable_events'),
                "anomalies": summary_data.get('anomalies'),
            },
            tags=self._derive_tags(summary_data, aggregated_data),
        )

        entity_id = storage.store_summary(
            user_id,
            summary_data,
            start_time,
            end_time,
            metadata=metadata,
        )

        return {
            "summary_entity_id": str(entity_id),
            "summary_type": "hourly",
            "summary_text": summary_data["summary_text"],
            "key_insights": summary_data.get("key_insights", []),
            "activity_counts": summary_data["activity_counts"],
        }

    def _execute_daily_summary(
        self,
        user_id: uuid.UUID,
        start_time: datetime,
        end_time: datetime,
        timezone: str,
    ) -> Dict[str, Any]:
        logger.info("executing_daily_summary", user_id=str(user_id))

        hourly_summaries_raw = storage.get_hourly_summaries(user_id, start_time, end_time)
        hourly_summaries = [
            {
                "summary_text": h["properties"]["summary_text"],
                "activity_counts": h["properties"]["activity_counts"],
            }
            for h in hourly_summaries_raw
        ]

        if not hourly_summaries:
            raise ValueError("No hourly summaries found for daily aggregation")

        summary_data = summarizer.generate_daily_summary(hourly_summaries)

        child_ids = [str(h['entity_id']) for h in hourly_summaries_raw]
        metadata = SummaryMetadata(
            timezone=timezone,
            source_types=['memory.hourly'],
            structured_context={
                "activity_counts": summary_data['activity_counts'],
                "child_summary_ids": child_ids,
                "num_child_summaries": len(hourly_summaries),
            },
            related_entity_ids=child_ids,
        )

        entity_id = storage.store_summary(
            user_id,
            summary_data,
            start_time,
            end_time,
            metadata=metadata,
        )

        for h in hourly_summaries_raw:
            storage.link_to_parent_summary(h["entity_id"], entity_id, user_id)

        return {
            "summary_entity_id": str(entity_id),
            "summary_type": "daily",
            "summary_text": summary_data["summary_text"],
            "activity_counts": summary_data["activity_counts"],
            "num_hourly_summaries": len(hourly_summaries),
        }

    def _execute_weekly_summary(
        self,
        user_id: uuid.UUID,
        start_time: datetime,
        end_time: datetime,
        timezone: str,
    ) -> Dict[str, Any]:
        return self._execute_rollup_summary(user_id, start_time, end_time, timezone, 'weekly')

    def _execute_rollup_summary(
        self,
        user_id: uuid.UUID,
        start_time: datetime,
        end_time: datetime,
        timezone: str,
        period_type: str,
    ) -> Dict[str, Any]:
        logger.info("executing_rollup_summary", user_id=str(user_id), period_type=period_type)

        daily_summaries_raw = storage.get_daily_summaries(user_id, start_time, end_time)
        daily_summaries = [
            {
                "summary_text": record['properties']['summary_text'],
                "activity_counts": record['properties']['activity_counts'],
            }
            for record in daily_summaries_raw
        ]

        if not daily_summaries:
            raise ValueError(f"No daily summaries found for {period_type} aggregation")

        summary_data = summarizer.generate_period_rollup(period_type, 'daily', daily_summaries)
        summary_data.setdefault('num_child_summaries', len(daily_summaries_raw))
        summary_data.setdefault('num_daily_summaries', len(daily_summaries_raw))
        child_ids = [str(record['entity_id']) for record in daily_summaries_raw]

        metadata = SummaryMetadata(
            timezone=timezone,
            source_types=['memory.daily'],
            structured_context={
                "activity_counts": summary_data['activity_counts'],
                "child_summary_ids": child_ids,
                "num_child_summaries": len(daily_summaries_raw),
            },
            related_entity_ids=child_ids,
        )

        entity_id = storage.store_summary(
            user_id,
            summary_data,
            start_time,
            end_time,
            metadata=metadata,
        )

        for record in daily_summaries_raw:
            storage.link_to_parent_summary(record['entity_id'], entity_id, user_id)

        return {
            "summary_entity_id": str(entity_id),
            "summary_type": summary_data['summary_type'],
            "summary_text": summary_data['summary_text'],
            "activity_counts": summary_data['activity_counts'],
            "num_daily_summaries": len(daily_summaries),
        }

    # ------------------------------------------------------------------
    # PgBoss helpers
    # ------------------------------------------------------------------
    def _detect_job_schema(self) -> JobSchema:
        rows = db.execute_query(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'pgboss'
              AND table_name = 'job'
            """
        )
        columns: Set[str] = {row['column_name'] for row in rows}

        def pick(candidates, default=None, required=True):
            for candidate in candidates:
                if candidate in columns:
                    return candidate
            if required and default is None:
                raise RuntimeError(f"Missing required column(s) {candidates} in pgboss.job")
            return default

        return JobSchema(
            priority=pick(['priority']),
            start_after=pick(['startafter', 'start_after']),
            created_on=pick(['createdon', 'created_on']),
            started_on=pick(['startedon', 'started_on']),
            completed_on=pick(['completedon', 'completed_on']),
            state=pick(['state']),
            data=pick(['data']),
            output=pick(['output', 'output_data'], default=None, required=False),
        )

    def _build_fetch_sql(self) -> str:
        schema = self.job_schema
        return f"""
            WITH ready AS (
                SELECT id
                FROM pgboss.job
                WHERE name = :queue_name
                  AND {schema.state} = 'created'
                  AND {schema.start_after} <= NOW()
                ORDER BY {schema.priority} DESC, {schema.created_on}
                LIMIT :batch_size
                FOR UPDATE SKIP LOCKED
            )
            UPDATE pgboss.job AS job
            SET {schema.state} = 'active',
                {schema.started_on} = NOW()
            FROM ready
            WHERE job.id = ready.id
            RETURNING job.id, job.{schema.data} AS data
        """

    # ------------------------------------------------------------------
    # JSON helpers
    # ------------------------------------------------------------------
    def _json_default(self, obj: Any):
        if isinstance(obj, (datetime, uuid.UUID)):
            return str(obj)
        return str(obj)

    # ------------------------------------------------------------------
    # Metadata helpers
    # ------------------------------------------------------------------
    def _derive_source_types(self, aggregated_data: Dict[str, Any]) -> list[str]:
        sources: list[str] = []
        for key, value in aggregated_data.items():
            if key in {"user_id", "start_time", "end_time"}:
                continue
            if isinstance(value, list) and value:
                sources.append(key)
        return sources or ["browser_history"]

    def _derive_tags(self, summary_data: Dict[str, Any], aggregated_data: Dict[str, Any]) -> list[str]:
        insights = summary_data.get('key_insights') or []
        if isinstance(insights, list):
            return insights[:5]
        return []


worker = SummaryWorker()

__all__ = ["worker", "SummaryWorker"]
