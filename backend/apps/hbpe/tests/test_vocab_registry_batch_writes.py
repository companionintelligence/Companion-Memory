"""
The batched assignment writes (ci.hbpe.tokenizer.vocab_registry): a batch is two
or three statements, not two or three per row; an id named twice keeps its
last assignment and bumps its cluster once; the single-row writers are
batches of one.
"""

from __future__ import annotations

from contextlib import contextmanager

import pytest

from ci.hbpe.tokenizer import vocab_registry as vr


class _Cursor:
    def __init__(self, log: list[tuple[str, object]]) -> None:
        self.log = log

    def execute(self, sql: str, params: object = None) -> None:
        self.log.append((" ".join(sql.split()), params))

    def __enter__(self) -> _Cursor:
        return self

    def __exit__(self, *_: object) -> None:
        return None


@pytest.fixture
def db(monkeypatch):
    """A fake connection; `execute_values` is recorded too, with the rows it was handed."""
    log: list[tuple[str, object]] = []

    class _Conn:
        def cursor(self) -> _Cursor:
            return _Cursor(log)

    @contextmanager
    def get_conn():
        yield _Conn()

    def execute_values(
        cur: _Cursor, sql: str, rows: list, template: str | None = None
    ) -> None:
        cur.log.append(
            (" ".join(sql.split()), {"rows": list(rows), "template": template})
        )

    monkeypatch.setattr(vr, "get_conn", get_conn)
    monkeypatch.setattr(vr.psycopg2.extras, "execute_values", execute_values)
    return log


def test_event_labels_are_one_upsert_and_one_bump_per_batch(db):
    vr.write_event_labels([("e1", "c1"), ("e2", "c1"), ("e3", "c2")])

    assert len(db) == 2
    upsert, bump = db
    assert upsert[0].startswith("INSERT INTO hbpe.l1_event_cluster")
    assert upsert[1]["rows"] == [("e1", "c1"), ("e2", "c1"), ("e3", "c2")]
    assert bump[0].startswith(
        "UPDATE hbpe.l1_clusters c SET member_count = c.member_count + b.n"
    )
    assert bump[1] == (["c1", "c2"], [2, 1])


def test_an_event_named_twice_keeps_its_last_cluster_and_is_counted_once(db):
    vr.write_event_labels([("e1", "c1"), ("e1", "c2")])

    upsert, bump = db
    assert upsert[1]["rows"] == [("e1", "c2")]
    assert bump[1] == (["c2"], [1])


def test_an_empty_batch_writes_nothing(db):
    vr.write_event_labels([])
    vr.write_content_labels([])

    assert db == []


def test_the_single_row_writers_are_batches_of_one(db):
    vr.write_event_label("e1", "u1", "WORK", "c1")

    assert [sql[:40] for sql, _ in db] == [
        "INSERT INTO hbpe.l1_event_cluster (event",
        "UPDATE hbpe.l1_clusters c SET member_cou",
    ]
    assert db[1][1] == (["c1"], [1])


def test_content_labels_are_three_statements_per_batch(db):
    vr.write_content_labels(
        [
            ("k1", "u1", "WORK", "l1a", "l2a"),
            ("k2", "u1", "WORK", "l1a", "l2a"),
            ("k3", "u1", "HOME", "l1b", "l2b"),
        ]
    )

    assert len(db) == 3
    clusters, context, bump = db
    assert clusters[0].startswith("INSERT INTO hbpe.l2_content_cluster")
    assert clusters[1]["rows"] == [("k1", "l2a"), ("k2", "l2a"), ("k3", "l2b")]
    assert context[0].startswith("INSERT INTO hbpe.content_context")
    assert context[1]["rows"] == [
        ("k1", "u1", "WORK", "l1a"),
        ("k2", "u1", "WORK", "l1a"),
        ("k3", "u1", "HOME", "l1b"),
    ]
    assert bump[0].startswith(
        "UPDATE hbpe.l2_clusters c SET member_count = c.member_count + b.n"
    )
    assert bump[1] == (["l2a", "l2b"], [2, 1])
