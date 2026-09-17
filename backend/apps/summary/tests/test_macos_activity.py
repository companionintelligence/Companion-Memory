"""macOS occurrence windows and summary/HBPE refresh regression coverage."""

import os
import re
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import psycopg2
import psycopg2.extras
import pytest

from ci.summary import summary_functions
from ci.summary.summary_sources import SUMMARY_SOURCES

QUERIES = {source.name: source.query for source in SUMMARY_SOURCES}
START = datetime(2026, 9, 1, 11, tzinfo=UTC)
END = datetime(2026, 9, 1, 12, tzinfo=UTC)
USER = "00000000-0000-4000-8000-000000000001"


def test_macos_activity_is_grounded_and_reaches_the_bounded_hourly_prompt():
    query = QUERIES["macos_activity"]
    assert "ev.user_id = :user_id" in query
    assert "ev.is_predicted IS NOT TRUE" in query
    assert "ev.is_inferred IS NOT TRUE" in query
    assert "ev.is_deleted = false" in query
    assert "ev.start_time < :end" in query
    assert "ev.end_time > :start" in query
    assert "created_at" not in query
    assert "ev.source_system IS DISTINCT FROM 'macos_activity'" in QUERIES["events"]
    data = {
        "macos_activity": [
            {"activity": "App usage: com.apple.Xcode", "observed_seconds": 900}
        ]
    }
    prompt = summary_functions.build_data_prompt(
        data, summary_functions.count_activities(data)
    )
    assert "com.apple.Xcode" in prompt
    assert "900" in prompt


@pytest.fixture
def pg():
    """Only a dedicated, empty test DB; CREATE SCHEMA refuses an existing ci schema."""
    url = os.environ.get("MACOS_TEST_DATABASE_URL")
    if not url:
        pytest.skip(
            "MACOS_TEST_DATABASE_URL must point to an empty disposable PostgreSQL database"
        )
    conn = psycopg2.connect(url)
    with conn.cursor() as cur:
        cur.execute("CREATE SCHEMA ci; CREATE SCHEMA hbpe")
    try:
        yield conn
    finally:
        conn.rollback()
        conn.close()


def test_macos_enriched_hour_is_classified_and_becomes_hbpe_bucket_tokens(monkeypatch):
    from ci.hbpe.buckets import SUMMARY_BUCKETS_PER_HOUR
    from ci.hbpe.inference import qwen
    from ci.hbpe.tokenizer import summary_tokenizer, vocab_registry

    narrative = "Worked in Xcode, visited Apple Developer, and made an outgoing call."
    prompts = []
    saved = []

    class Model:
        def generate(self, message, **_kwargs):
            prompts.append(message)
            return (
                '{"l0":"WORK"}' if "Categories:" in message else '{"l1":"Programming"}'
            )

    monkeypatch.setattr(qwen, "get_qwen", Model)
    monkeypatch.setattr(vocab_registry, "get_l1_vocab", lambda *_args: [])
    monkeypatch.setattr(
        vocab_registry, "get_or_create_l1", lambda *_args: ("programming", False)
    )
    monkeypatch.setattr(
        summary_tokenizer, "_store_summary_label", lambda *args: saved.append(args)
    )
    assert (
        summary_tokenizer.SummaryTokenizer()._label_rows(
            USER,
            [{"summary_id": "summary", "content": {"summary_text": narrative}}],
            "test",
        )
        == 1
    )
    assert all("Xcode" in prompt for prompt in prompts)
    assert saved == [("summary", "WORK", "programming", narrative)]
    tokens = summary_tokenizer._build_summary_tokens(
        [{"period_start": START, "l0_class": saved[0][1], "l1_cluster_id": saved[0][2]}]
    )
    assert len(tokens) == 2 * SUMMARY_BUCKETS_PER_HOUR
    assert all(token["soft_prob_vector"] == [0.7] for token in tokens)


def test_actual_postgres_query_clips_spans_and_excludes_other_users_predictions_and_import_hour(
    pg,
):
    with pg.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            CREATE TABLE ci.entities (entity_id uuid, name text);
            CREATE TABLE ci.events (
                event_id uuid, user_id uuid, metadata jsonb DEFAULT '{}',
                source_system text, start_time timestamptz, end_time timestamptz,
                is_deleted boolean DEFAULT false, is_predicted boolean, is_inferred boolean
            )
        """)

        def event(start, end, **flags):
            event_id = str(uuid4())
            cur.execute(
                "INSERT INTO ci.entities VALUES (%s, 'App usage: com.apple.Xcode')",
                (event_id,),
            )
            cur.execute(
                """
                INSERT INTO ci.events(event_id, user_id, source_system, start_time, end_time,
                    is_deleted, is_predicted, is_inferred)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """,
                (
                    event_id,
                    flags.get("user", USER),
                    "macos_activity",
                    start,
                    end,
                    flags.get("deleted", False),
                    flags.get("predicted"),
                    flags.get("inferred"),
                ),
            )

        event("2026-09-01T10:45Z", "2026-09-01T11:15Z")
        event("2026-09-01T11:45Z", "2026-09-01T12:15Z")
        event("2026-09-01T11:30Z", None)  # instantaneous observation
        event("2026-09-01T10:00Z", "2026-09-01T11:00Z")  # exclusive lower end
        event("2026-09-01T12:00Z", None)  # exclusive upper start
        event("2026-09-01T11:10Z", None, user=str(uuid4()))
        event("2026-09-01T11:10Z", None, predicted=True)
        event("2026-09-01T11:10Z", None, inferred=True)
        event("2026-09-01T11:10Z", None, deleted=True)
        sql = re.sub(
            r":(user_id|start|end|limit)\b", r"%(\1)s", QUERIES["macos_activity"]
        )
        cur.execute(sql, {"user_id": USER, "start": START, "end": END, "limit": 100})
        rows = cur.fetchall()
        assert len(rows) == 1
        assert rows[0]["observation_count"] == 3
        assert rows[0]["observed_seconds"] == 1800
        assert rows[0]["first_seen_at"] == START
        assert rows[0]["last_seen_at"] == END
        cur.execute(
            sql,
            {
                "user_id": USER,
                "start": "2026-09-15T11:00Z",
                "end": "2026-09-15T12:00Z",
                "limit": 100,
            },
        )
        assert cur.fetchall() == []


def test_forced_summary_refresh_invalidates_labels_and_rejects_inflight_old_text(
    pg, monkeypatch
):
    from ci.hbpe.tokenizer import summary_tokenizer

    @contextmanager
    def connection():
        yield pg

    monkeypatch.setattr(summary_tokenizer, "get_conn", connection)
    summary_id = str(uuid4())
    with pg.cursor() as cur:
        cur.execute("""
            CREATE TABLE ci.summaries (
                summary_id uuid PRIMARY KEY, content jsonb, period_type text,
                period_start timestamptz, period_end timestamptz, user_id uuid
            );
            CREATE TABLE hbpe.summary_l1_label (
                summary_id uuid PRIMARY KEY, l0_class text, l1_cluster_id uuid
            )
        """)
        migration = (
            Path(__file__).parents[2]
            / "api/db/postgres/migrations/20260915152000_refresh_hourly_summary_labels.sql"
        )
        cur.execute(migration.read_text().split("-- migrate:down")[0])
        cur.execute(
            "INSERT INTO ci.summaries VALUES (%s, %s, 'hourly', %s, %s, %s)",
            (summary_id, '{"summary_text":"No activity"}', START, END, USER),
        )
        summary_tokenizer._store_summary_label(
            summary_id, "LEISURE", None, "No activity"
        )
        cur.execute("SELECT count(*) FROM hbpe.summary_l1_label")
        assert cur.fetchone()[0] == 1
        cur.execute(
            "UPDATE ci.summaries SET content = content || '{\"count\": 2}'::jsonb"
        )
        cur.execute("SELECT count(*) FROM hbpe.summary_l1_label")
        assert cur.fetchone()[0] == 1  # unrelated metadata keeps a valid label
        cur.execute(
            'UPDATE ci.summaries SET content = \'{"summary_text":"Worked in Xcode"}\'::jsonb'
        )
        cur.execute("SELECT count(*) FROM hbpe.summary_l1_label")
        assert cur.fetchone()[0] == 0
        summary_tokenizer._store_summary_label(
            summary_id, "LEISURE", None, "No activity"
        )
        cur.execute("SELECT count(*) FROM hbpe.summary_l1_label")
        assert cur.fetchone()[0] == 0  # a stale in-flight classification cannot return
        summary_tokenizer._store_summary_label(
            summary_id, "WORK", None, "Worked in Xcode"
        )
        cur.execute("SELECT l0_class FROM hbpe.summary_l1_label")
        assert cur.fetchone()[0] == "WORK"
        # Summary-only installations do not require an HBPE table.
        cur.execute("DROP TABLE hbpe.summary_l1_label")
        cur.execute(
            'UPDATE ci.summaries SET content = \'{"summary_text":"Different text"}\'::jsonb'
        )
        cur.execute(migration.read_text().split("-- migrate:down")[1])
