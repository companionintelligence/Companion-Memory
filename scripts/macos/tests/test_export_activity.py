"""Acquisition regression tests using synthetic SQLite databases only."""

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "export_activity", Path(__file__).parents[1] / "export_activity.py"
)
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


def test_snapshot_includes_committed_wal_without_changing_source(tmp_path):
    source = tmp_path / "source.sqlite"
    with sqlite3.connect(source) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("CREATE TABLE sample (value TEXT)")
        db.execute("INSERT INTO sample VALUES ('committed only in WAL')")
        db.commit()
        before = source.read_bytes()
        wal_before = Path(str(source) + "-wal").read_bytes()
        destination = tmp_path / "copy.sqlite"
        exporter.snapshot(source, destination)
        assert source.read_bytes() == before
        assert Path(str(source) + "-wal").read_bytes() == wal_before
        with sqlite3.connect(destination) as copy:
            assert (
                copy.execute("SELECT value FROM sample").fetchone()[0]
                == "committed only in WAL"
            )
        assert not Path(str(destination) + "-wal").exists()
        assert destination.stat().st_mode & 0o777 == 0o600


def test_missing_sources_are_reported_and_not_created(tmp_path):
    output = tmp_path / "snapshot"
    report = exporter.export_activity(
        tmp_path / "home", output, "test-mac", ["knowledge"]
    )
    assert report["sources"][0]["status"] == "unavailable"
    assert not (tmp_path / "home").exists()
    assert not (output / "knowledge.sqlite").exists()
    assert json.loads((output / exporter.MANIFEST).read_text()) == report
    assert output.stat().st_mode & 0o777 == 0o700


def test_exports_keep_device_identity_and_never_overwrite(tmp_path):
    home = tmp_path / "home"
    source = home / exporter.SOURCES["safari"]
    source.parent.mkdir(parents=True)
    with sqlite3.connect(source) as db:
        db.execute("CREATE TABLE sample (value TEXT)")
    first = exporter.export_activity(
        home, tmp_path / "first", "account-on-mac", ["safari"]
    )
    second = exporter.export_activity(
        home, tmp_path / "second", "account-on-mac", ["safari"]
    )
    assert first["deviceId"] == second["deviceId"]
    assert first["sources"] == [{"name": "safari", "status": "ok"}]
    assert source.exists()
    with pytest.raises(FileExistsError):
        exporter.export_activity(home, tmp_path / "first", "account-on-mac", ["safari"])


def test_snapshot_timeout_leaves_no_published_database(tmp_path, monkeypatch):
    def timeout(*_args):
        raise TimeoutError("busy database")

    monkeypatch.setattr(exporter, "snapshot", timeout)
    report = exporter.export_activity(tmp_path, tmp_path / "output", "mac", ["calls"])
    assert report["sources"][0]["status"] == "unavailable"
    assert not (tmp_path / "output/calls.sqlite").exists()
