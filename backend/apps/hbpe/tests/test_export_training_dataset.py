"""Tests for the headless training export: writer, validator, source read and CLI."""

from __future__ import annotations

import contextlib
import json
import uuid
from collections.abc import Callable, Iterator
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.config import settings
from ci.hbpe.model import dataset as dataset_mod
from ci.hbpe.model import export_training_dataset as export_mod
from ci.hbpe.model import vocab as vocab_mod
from ci.hbpe.model.export_training_dataset import (
    DATASET_FILENAME,
    MANIFEST_FILENAME,
    TrainingExportError,
    main,
    read_user_sequences,
    validate_training_export,
    write_training_export,
)
from ci.hbpe.model.parallel_trainer import TokenStreamFileDataset
from ci.hbpe.model.train_runner import run_headless_job
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

USER_ID = "3f2a9c1e-7b4d-4e8a-9c2f-1d5e6a7b8c9d"
JOB_ID = "job-export-test"


def _day(seed: int) -> list[dict[str, Any]]:
    """A user-day shaped like hbpe.token_stream rows: SOD, L0, L1, then EOD."""
    tokens: list[dict[str, Any]] = [
        {"level": "SOD", "token_id": "SOD", "soft_prob": [1.0], "bucket_idx": 0}
    ]
    for i in range(6):
        tokens.append(
            {
                "level": "L0",
                "token_id": L0_CLASSES[(seed + i) % len(L0_CLASSES)],
                "soft_prob": [0.7],
                "bucket_idx": 4 + 4 * i,
            }
        )
    for j in range(2):
        tokens.append(
            {
                "level": "L1",
                "token_id": str(uuid.UUID(int=seed * 1000 + j + 1)),
                "soft_prob": [0.8125],
                "bucket_idx": 6 + 4 * j,
            }
        )
    tokens.sort(key=lambda t: t["bucket_idx"])
    tokens.append(
        {
            "level": "EOD",
            "token_id": "EOD",
            "soft_prob": [1.0],
            "bucket_idx": BUCKETS_PER_DAY - 1,
        }
    )
    return tokens


def _days(n: int) -> list[list[dict[str, Any]]]:
    return [_day(seed) for seed in range(1, n + 1)]


def _fields(**overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "userId": USER_ID,
        "jobId": JOB_ID,
        "hyperparameters": {"batchSize": 2, "epochs": 1},
        "resourcePolicy": {"devicePreference": "cpu"},
    }
    fields.update(overrides)
    return fields


def _assert_nothing_written(out: Path) -> None:
    leftovers = sorted(p.name for p in out.iterdir()) if out.exists() else []
    assert leftovers == []


def _assert_only_export_files(out: Path) -> None:
    assert sorted(p.name for p in out.iterdir()) == [
        DATASET_FILENAME,
        MANIFEST_FILENAME,
    ]


def _load_json(path: Path) -> dict[str, Any]:
    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.write_text(json.dumps(manifest), encoding="utf-8")


# ── Round trip ────────────────────────────────────────────────────────────────


def test_round_trip_returns_the_same_sequences(tmp_path: Path) -> None:
    days = _days(5)
    export = write_training_export(days, tmp_path / "export", _fields())

    loaded = TokenStreamFileDataset(export.dataset_path)
    assert [loaded[i] for i in range(len(loaded))] == days

    lines = export.dataset_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 5
    assert all(isinstance(json.loads(line), list) for line in lines)
    assert export.dataset_path.read_bytes().isascii()

    manifest = _load_json(export.manifest_path)
    assert manifest["userId"] == USER_ID
    assert manifest["jobId"] == JOB_ID
    assert manifest["hyperparameters"] == {
        "batchSize": 2,
        "epochs": 1,
        "learningRate": 1e-4,
    }
    assert manifest["resourcePolicy"] == {"devicePreference": "cpu"}
    assert manifest["dataset"]["valFraction"] == 0.15
    assert manifest["dataset"]["days"] == 5
    assert manifest["dataset"]["tokens"] == sum(len(d) for d in days)

    assert export.days == 5
    assert export.tokens == sum(len(d) for d in days)
    assert export.user_id == USER_ID
    assert export.job_id == JOB_ID
    assert validate_training_export(export.manifest_path, export.dataset_path) == export
    _assert_only_export_files(export.manifest_path.parent)


def test_caller_fields_pass_through_and_defaults_fill_in(tmp_path: Path) -> None:
    export = write_training_export(
        _days(4),
        tmp_path / "export",
        _fields(source={"table": "hbpe.token_stream", "since": "2026-10-01"}),
    )
    manifest = _load_json(export.manifest_path)
    assert manifest["source"] == {"table": "hbpe.token_stream", "since": "2026-10-01"}
    assert manifest["resourcePolicy"] == {"devicePreference": "cpu"}


# ── Manifest validation ───────────────────────────────────────────────────────


def _set(path: tuple[str, ...], value: Any) -> Callable[[dict[str, Any]], None]:
    def mutate(manifest: dict[str, Any]) -> None:
        target = manifest
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    return mutate


def _drop(*path: str) -> Callable[[dict[str, Any]], None]:
    def mutate(manifest: dict[str, Any]) -> None:
        target = manifest
        for key in path[:-1]:
            target = target[key]
        del target[path[-1]]

    return mutate


MANIFEST_FAILURES = [
    pytest.param(_drop("userId"), "userId", id="missing-userId"),
    pytest.param(_set(("userId",), USER_ID.upper()), "userId", id="uppercase-userId"),
    pytest.param(_set(("userId",), "headless-user"), "userId", id="non-uuid-userId"),
    pytest.param(_set(("jobId",), "   "), "jobId", id="blank-jobId"),
    pytest.param(_drop("hyperparameters"), "hyperparameters", id="no-hyperparameters"),
    pytest.param(
        _set(("hyperparameters", "batchSize"), 0), "batchSize", id="batchSize-zero"
    ),
    pytest.param(
        _set(("hyperparameters", "batchSize"), "16"), "batchSize", id="batchSize-str"
    ),
    pytest.param(
        _set(("hyperparameters", "batchSize"), True), "batchSize", id="batchSize-bool"
    ),
    pytest.param(_set(("hyperparameters", "epochs"), 0), "epochs", id="epochs-zero"),
    pytest.param(
        _set(("hyperparameters", "learningRate"), 0),
        "learningRate",
        id="learningRate-zero",
    ),
    pytest.param(
        _set(("hyperparameters", "learningRate"), float("nan")),
        "learningRate",
        id="learningRate-nan",
    ),
    pytest.param(
        _set(("resourcePolicy", "devicePreference"), "tpu"),
        "devicePreference",
        id="unknown-device",
    ),
    pytest.param(_set(("dataset", "valFraction"), 0), "valFraction", id="val-zero"),
    pytest.param(_set(("dataset", "valFraction"), 1.0), "valFraction", id="val-one"),
    pytest.param(
        _set(("dataset", "valFraction"), 1.5), "valFraction", id="val-above-one"
    ),
]


@pytest.mark.parametrize(("mutate", "fragment"), MANIFEST_FAILURES)
def test_validator_rejects_bad_manifest_fields(
    tmp_path: Path, mutate: Callable[[dict[str, Any]], None], fragment: str
) -> None:
    export = write_training_export(_days(4), tmp_path / "export", _fields())
    manifest = _load_json(export.manifest_path)
    mutate(manifest)
    _write_manifest(export.manifest_path, manifest)

    with pytest.raises(TrainingExportError, match=fragment):
        validate_training_export(export.manifest_path, export.dataset_path)


def test_validator_rejects_a_manifest_that_is_not_an_object(tmp_path: Path) -> None:
    export = write_training_export(_days(4), tmp_path / "export", _fields())
    export.manifest_path.write_text("[]", encoding="utf-8")
    with pytest.raises(TrainingExportError, match="JSON object"):
        validate_training_export(export.manifest_path, export.dataset_path)


def test_validator_rejects_a_manifest_that_is_not_json(tmp_path: Path) -> None:
    export = write_training_export(_days(4), tmp_path / "export", _fields())
    export.manifest_path.write_text("{not json", encoding="utf-8")
    with pytest.raises(TrainingExportError, match="not valid JSON"):
        validate_training_export(export.manifest_path, export.dataset_path)


def test_validator_rejects_a_dataset_changed_after_export(tmp_path: Path) -> None:
    export = write_training_export(_days(4), tmp_path / "export", _fields())
    lines = export.dataset_path.read_text(encoding="utf-8").splitlines()
    first = json.loads(lines[0])
    first[1]["bucket_idx"] += 1
    lines[0] = json.dumps(first, separators=(",", ":"))
    export.dataset_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(TrainingExportError, match="sha256"):
        validate_training_export(export.manifest_path, export.dataset_path)


def test_validator_rejects_a_dataset_under_the_runner_minimum(tmp_path: Path) -> None:
    export = write_training_export(_days(4), tmp_path / "export", _fields())
    export.dataset_path.write_text(
        "".join(json.dumps(day) + "\n" for day in _days(3)), encoding="utf-8"
    )
    manifest = _load_json(export.manifest_path)
    for key in ("sha256", "days", "tokens"):
        del manifest["dataset"][key]
    _write_manifest(export.manifest_path, manifest)

    with pytest.raises(TrainingExportError, match="at least 4"):
        validate_training_export(export.manifest_path, export.dataset_path)


def test_validator_checks_every_day_in_a_hand_written_dataset(tmp_path: Path) -> None:
    export = write_training_export(_days(4), tmp_path / "export", _fields())
    days = _days(4)
    days[2][3]["level"] = "BOGUS"
    export.dataset_path.write_text(
        "".join(json.dumps(day) + "\n" for day in days), encoding="utf-8"
    )
    manifest = _load_json(export.manifest_path)
    for key in ("sha256", "days", "tokens"):
        del manifest["dataset"][key]
    _write_manifest(export.manifest_path, manifest)

    with pytest.raises(TrainingExportError, match="level"):
        validate_training_export(export.manifest_path, export.dataset_path)


def test_validator_reports_a_missing_dataset(tmp_path: Path) -> None:
    export = write_training_export(_days(4), tmp_path / "export", _fields())
    with pytest.raises(TrainingExportError, match="dataset not found"):
        validate_training_export(export.manifest_path, tmp_path / "absent.jsonl")


# ── Writer refusals (nothing is left behind) ──────────────────────────────────


def test_writer_refuses_fewer_days_than_the_runner_needs(tmp_path: Path) -> None:
    out = tmp_path / "export"
    with pytest.raises(TrainingExportError, match="at least 4"):
        write_training_export(_days(3), out, _fields())
    assert not out.exists()


def _mutated(mutate: Callable[[list[list[dict[str, Any]]]], None]) -> list[Any]:
    days: list[Any] = _days(4)
    mutate(days)
    return days


BAD_DAYS = [
    pytest.param(
        _mutated(lambda d: d[1][2].__setitem__("level", "BOGUS")),
        "level must be one of",
        id="unknown-level",
    ),
    pytest.param(
        _mutated(lambda d: d[1][1].__setitem__("token_id", "DANCING")),
        "L0 token_id",
        id="l0-outside-class-list",
    ),
    pytest.param(
        _mutated(lambda d: d[1][1].__setitem__("bucket_idx", BUCKETS_PER_DAY)),
        "bucket_idx",
        id="bucket-too-high",
    ),
    pytest.param(
        _mutated(lambda d: d[1][1].__setitem__("bucket_idx", -1)),
        "bucket_idx",
        id="bucket-negative",
    ),
    pytest.param(
        _mutated(lambda d: d[1][1].__setitem__("bucket_idx", "4")),
        "bucket_idx",
        id="bucket-string",
    ),
    pytest.param(
        _mutated(lambda d: d[1][0].__setitem__("token_id", "WORK")),
        "token_id SOD",
        id="sod-token-id",
    ),
    pytest.param(
        _mutated(
            lambda d: d[1].__setitem__(0, dict(d[1][0], level="L0", token_id="WORK"))
        ),
        "start with SOD",
        id="no-leading-sod",
    ),
    pytest.param(
        _mutated(lambda d: d[1].pop()),
        "end with EOD",
        id="no-trailing-eod",
    ),
    pytest.param(
        _mutated(lambda d: d.__setitem__(1, [])),
        "non-empty list",
        id="empty-day",
    ),
    pytest.param(
        _mutated(lambda d: d.__setitem__(1, tuple(d[1]))),
        "non-empty list",
        id="tuple-day",
    ),
    pytest.param(
        _mutated(lambda d: d[1].__setitem__(1, "L0")),
        "must be an object",
        id="token-not-object",
    ),
    pytest.param(
        _mutated(lambda d: d[1][1].__setitem__("soft_prob", [float("nan")])),
        "soft_prob",
        id="nan-soft-prob",
    ),
    pytest.param(
        _mutated(lambda d: d[1][1].__setitem__("when", object())),
        "strict JSON",
        id="not-json-serialisable",
    ),
]


@pytest.mark.parametrize(("days", "fragment"), BAD_DAYS)
def test_writer_refuses_a_bad_day_and_writes_nothing(
    tmp_path: Path, days: list[Any], fragment: str
) -> None:
    out = tmp_path / "export"
    with pytest.raises(TrainingExportError, match=fragment):
        write_training_export(days, out, _fields())
    _assert_nothing_written(out)


@pytest.mark.parametrize(
    ("fields", "fragment"),
    [
        pytest.param(_fields(userId="headless-user"), "userId", id="bad-user"),
        pytest.param(_fields(jobId=""), "jobId", id="blank-job"),
        pytest.param(
            _fields(hyperparameters={"epochs": 0}), "epochs", id="epochs-zero"
        ),
        pytest.param(_fields(dataset={"valFraction": 1}), "valFraction", id="val-one"),
    ],
)
def test_writer_checks_manifest_fields_before_writing(
    tmp_path: Path, fields: dict[str, Any], fragment: str
) -> None:
    out = tmp_path / "export"
    with pytest.raises(TrainingExportError, match=fragment):
        write_training_export(_days(4), out, fields)
    assert not out.exists()


def test_writer_refuses_to_replace_an_export_without_overwrite(tmp_path: Path) -> None:
    out = tmp_path / "export"
    first = write_training_export(_days(4), out, _fields(jobId="job-a"))

    with pytest.raises(TrainingExportError, match="overwrite=True"):
        write_training_export(_days(5), out, _fields(jobId="job-b"))
    assert _load_json(first.manifest_path)["jobId"] == "job-a"
    assert first.dataset_path.read_text(encoding="utf-8").count("\n") == 4

    replaced = write_training_export(
        _days(5), out, _fields(jobId="job-b"), overwrite=True
    )
    assert replaced.days == 5
    assert replaced.job_id == "job-b"
    _assert_only_export_files(out)


# ── Source read ───────────────────────────────────────────────────────────────


class _FakeCursor:
    """Answers the two nightly training reads from an in-memory store."""

    def __init__(self, store: dict[str, dict[str, list[dict[str, Any]]]]) -> None:
        self._store = store
        self._rows: list[Any] = []

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        user_id = params[0]
        days = self._store.get(user_id, {})
        if "DISTINCT date::text" in sql:
            self._rows = [(d,) for d in sorted(days)]
        elif "SELECT level, token_id, soft_prob, bucket_idx" in sql:
            self._rows = [dict(row) for row in days.get(params[1], [])]
        else:
            raise AssertionError(f"unexpected query: {sql}")

    def fetchall(self) -> list[Any]:
        return self._rows


class _FakeConnection:
    def __init__(self, store: dict[str, dict[str, list[dict[str, Any]]]]) -> None:
        self._store = store

    def cursor(self, *args: Any, **kwargs: Any) -> _FakeCursor:
        return _FakeCursor(self._store)


def _fake_database(
    store: dict[str, dict[str, list[dict[str, Any]]]],
) -> Callable[[], contextlib.AbstractContextManager[_FakeConnection]]:
    @contextlib.contextmanager
    def get_conn() -> Iterator[_FakeConnection]:
        yield _FakeConnection(store)

    return get_conn


def test_source_reads_one_users_days_since_the_cutoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    other = str(uuid.uuid4())
    store = {
        USER_ID: {
            "2026-10-01": _day(1),
            "2026-10-03": _day(3),
            "2026-10-05": _day(5),
            "2026-10-09": _day(9),
        },
        other: {"2026-10-04": _day(4)},
    }
    monkeypatch.setattr(dataset_mod, "get_conn", _fake_database(store))

    got = read_user_sequences(USER_ID.upper(), date(2026, 10, 3))
    assert got == [
        store[USER_ID]["2026-10-03"],
        store[USER_ID]["2026-10-05"],
        store[USER_ID]["2026-10-09"],
    ]
    assert read_user_sequences(USER_ID, date(2026, 10, 5))[0] == _day(5)
    assert read_user_sequences(USER_ID, date(2027, 1, 1)) == []


def test_source_rejects_a_user_id_that_is_not_a_uuid() -> None:
    with pytest.raises(TrainingExportError, match="user id must be a UUID"):
        read_user_sequences("headless-user", date(2026, 10, 1))


# ── CLI ───────────────────────────────────────────────────────────────────────


def _cli_args(out: Path, *extra: str) -> list[str]:
    return [
        "--user-id",
        USER_ID,
        "--since",
        "2026-10-01",
        "--out-dir",
        str(out),
        *extra,
    ]


def test_cli_writes_a_runner_ready_export(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    seen: list[tuple[str, date]] = []

    def fake_read(user_id: str, since: date) -> list[list[dict[str, Any]]]:
        seen.append((user_id, since))
        return _days(4)

    monkeypatch.setattr(export_mod, "read_user_sequences", fake_read)
    out = tmp_path / "export"

    code = main(
        _cli_args(
            out,
            "--job-id",
            JOB_ID,
            "--batch-size",
            "2",
            "--epochs",
            "1",
            "--device",
            "cpu",
        )
    )

    assert code == 0
    assert seen == [(USER_ID, date(2026, 10, 1))]
    export = validate_training_export(out / MANIFEST_FILENAME, out / DATASET_FILENAME)
    assert (export.days, export.job_id, export.user_id) == (4, JOB_ID, USER_ID)
    manifest = _load_json(out / MANIFEST_FILENAME)
    assert manifest["source"] == {"table": "hbpe.token_stream", "since": "2026-10-01"}
    printed = capsys.readouterr().out
    assert "ci.hbpe.model.train_runner" in printed
    assert "--manifest" in printed


def test_cli_generates_a_job_id_when_none_is_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(export_mod, "read_user_sequences", lambda u, s: _days(4))
    out = tmp_path / "export"

    assert main(_cli_args(out)) == 0

    job_id = _load_json(out / MANIFEST_FILENAME)["jobId"]
    assert str(uuid.UUID(job_id)) == job_id


def test_cli_replaces_an_export_only_with_overwrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(export_mod, "read_user_sequences", lambda u, s: _days(4))
    out = tmp_path / "export"
    assert main(_cli_args(out)) == 0
    assert main(_cli_args(out)) == 1
    assert main(_cli_args(out, "--overwrite")) == 0


def test_cli_reports_too_few_days_with_exit_code_1(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(export_mod, "read_user_sequences", lambda u, s: _days(2))
    out = tmp_path / "export"

    assert main(_cli_args(out)) == 1
    assert "at least 4" in capsys.readouterr().err
    assert not out.exists()


@pytest.mark.parametrize(
    "args",
    [
        pytest.param(
            ["--user-id", "not-a-uuid", "--since", "2026-10-01", "--out-dir", "x"],
            id="bad-user-id",
        ),
        pytest.param(
            ["--user-id", USER_ID, "--since", "2026-02-30", "--out-dir", "x"],
            id="bad-date",
        ),
        pytest.param(
            [*_cli_args(Path("x")), "--epochs", "0"],
            id="zero-epochs",
        ),
    ],
)
def test_cli_rejects_bad_arguments(args: list[str]) -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(args)
    assert excinfo.value.code == 2


# ── End to end through the runner ─────────────────────────────────────────────


def _no_database() -> None:
    raise RuntimeError("no database in the headless export test")


def test_run_headless_job_accepts_the_export(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # The runner is unchanged. Two things stay off the test machine: its model
    # cache, and PostgreSQL. With the database unavailable, the runner builds
    # the L1 vocabulary from the dataset, which is the path it takes when
    # decoupled from the database.
    monkeypatch.setattr(settings, "models_dir", str(tmp_path / "models"))
    monkeypatch.setattr(vocab_mod, "get_conn", _no_database)

    export = write_training_export(
        _days(4),
        tmp_path / "export",
        _fields(
            jobId="job-e2e",
            hyperparameters={"batchSize": 1, "epochs": 1},
            resourcePolicy={"devicePreference": "cpu"},
        ),
    )

    summary = run_headless_job(
        export.manifest_path, export.dataset_path, tmp_path / "artifacts"
    )

    assert summary["status"] == "COMPLETED"
    assert summary["jobId"] == "job-e2e"
    assert Path(summary["artifacts"]["maeCheckpoint"]).exists()
    assert Path(summary["artifacts"]["hmtCheckpoint"]).exists()
    assert "CI_TRAIN_COMPLETE" in capsys.readouterr().out
