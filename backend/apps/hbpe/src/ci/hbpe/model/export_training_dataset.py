"""
Export one user's serialized token stream as a headless training job.

The export is the pair of inputs ``ci.hbpe.model.train_runner`` reads:

  dataset.jsonl  one user-day per line: a JSON array of token objects in
                 seq_order, the shape ``TokenStreamFileDataset`` loads.
  manifest.json  the TrainingJobManifest fields ``run_headless_job`` reads
                 (userId, jobId, hyperparameters, resourcePolicy, dataset).
                 The export also writes dataset.days, dataset.tokens and
                 dataset.sha256, which validate_training_export compares with
                 the dataset. The runner ignores those three keys.

The runner is the reference for both formats. ``write_training_export``
checks its inputs, writes both files into a staging directory beside
``out_dir``, re-reads the pair with the runner's own loader, and then moves the
staging directory into place as a whole. A file the runner would reject never
reaches ``out_dir``. ``out_dir`` is not created before that move, so a failed
export leaves no empty directory behind.

``validate_training_export`` is the same re-read on its own, for an export made
elsewhere. It is stricter than the runner: the runner fills in missing manifest
fields with defaults, and maps an unknown L0 token to PAD without a word. This
check refuses both.

Source: ``read_user_sequences`` reads ``hbpe.token_stream`` through the
nightly training read in ``ci.hbpe.model.dataset`` (``_fetch_dates`` and
``TokenStreamDataset``). It does not read the rollup tables.

Nothing in the nightly pipeline calls this module, so it changes no runtime
output. It writes files only when it is called.

CLI::

    python -m ci.hbpe.model.export_training_dataset \\
        --user-id <uuid> --since YYYY-MM-DD --out-dir <dir>

Needs the HBPE database settings (DATABASE_URL, or DATABASE_HOST and related
variables) in the environment, as the other HBPE jobs do.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import shutil
import sys
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import psycopg2

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.model.dataset import TokenStreamDataset, _fetch_dates
from ci.hbpe.model.parallel_trainer import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_EPOCHS,
    DEFAULT_LR,
    TokenStreamFileDataset,
)
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

log = logging.getLogger(__name__)

DATASET_FILENAME = "dataset.jsonl"
MANIFEST_FILENAME = "manifest.json"

# run_headless_job refuses a dataset with fewer days than this.
RUNNER_MIN_DAYS = 4

# The defaults run_headless_job applies to the fields an export always writes.
DEFAULT_VAL_FRACTION = 0.15
DEFAULT_DEVICE = "auto"
DEFAULT_HYPERPARAMETERS: dict[str, Any] = {
    "batchSize": DEFAULT_BATCH_SIZE,
    "epochs": DEFAULT_EPOCHS,
    "learningRate": DEFAULT_LR,
}

# Levels the serialized stream uses (SOD | L0 | L1 | L2 | EOD).
TOKEN_LEVELS = frozenset({"SOD", "L0", "L1", "L2", "EOD"})

# Checked with fullmatch: "$" also accepts "cpu" followed by a newline.
_DEVICE_RE = re.compile(r"auto|cpu|mps|cuda(?::[0-9]+)?")


class TrainingExportError(ValueError):
    """An export input or output the runner would reject, or cannot be written."""


@dataclass(frozen=True)
class TrainingExport:
    manifest_path: Path
    dataset_path: Path
    user_id: str
    job_id: str
    days: int
    tokens: int


# ── Validation of the runner's inputs ─────────────────────────────────────────


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _parse_user_id(value: str) -> str:
    """Return the canonical lowercase hyphenated form of a UUID string."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError as exc:
        raise TrainingExportError(f"user id must be a UUID, got {value!r}") from exc


def _canonical_uuid(value: object, field: str) -> str:
    if isinstance(value, str):
        try:
            if str(uuid.UUID(value)) == value:
                return value
        except ValueError:
            pass
    raise TrainingExportError(
        f"{field} must be a lowercase hyphenated UUID, got {value!r}"
    )


def _require_mapping(manifest: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    value = manifest.get(key)
    if not isinstance(value, Mapping):
        raise TrainingExportError(f"manifest {key} must be an object, got {value!r}")
    return value


def _check_manifest(manifest: Mapping[str, Any]) -> tuple[str, str]:
    """Check the fields run_headless_job reads. Returns (userId, jobId)."""
    user_id = _canonical_uuid(manifest.get("userId"), "manifest userId")

    job_id = manifest.get("jobId")
    if not isinstance(job_id, str) or not job_id.strip():
        raise TrainingExportError(
            f"manifest jobId must be a non-empty string, got {job_id!r}"
        )

    hyper = _require_mapping(manifest, "hyperparameters")
    batch_size = hyper.get("batchSize")
    if not _is_int(batch_size) or batch_size < 1:
        raise TrainingExportError(
            f"hyperparameters.batchSize must be an integer >= 1, got {batch_size!r}"
        )
    epochs = hyper.get("epochs")
    if not _is_int(epochs) or epochs < 1:
        raise TrainingExportError(
            f"hyperparameters.epochs must be an integer >= 1, got {epochs!r}"
        )
    learning_rate = hyper.get("learningRate")
    if (
        not _is_number(learning_rate)
        or not math.isfinite(learning_rate)
        or learning_rate <= 0
    ):
        raise TrainingExportError(
            f"hyperparameters.learningRate must be a finite number > 0, got {learning_rate!r}"
        )

    resource = _require_mapping(manifest, "resourcePolicy")
    device = resource.get("devicePreference")
    if not isinstance(device, str) or not _DEVICE_RE.fullmatch(device):
        raise TrainingExportError(
            "resourcePolicy.devicePreference must be auto, cpu, mps or cuda[:N], "
            f"got {device!r}"
        )

    dataset = _require_mapping(manifest, "dataset")
    val_fraction = dataset.get("valFraction")
    if (
        not _is_number(val_fraction)
        or not math.isfinite(val_fraction)
        or not 0 < val_fraction < 1
    ):
        raise TrainingExportError(
            f"dataset.valFraction must be a number in (0, 1), got {val_fraction!r}"
        )

    return user_id, job_id


def _check_token(token: object, where: str) -> None:
    if not isinstance(token, dict):
        raise TrainingExportError(f"{where}: a token must be an object")

    level = token.get("level")
    if not isinstance(level, str) or level not in TOKEN_LEVELS:
        raise TrainingExportError(
            f"{where}: level must be one of {sorted(TOKEN_LEVELS)}, got {level!r}"
        )

    token_id = token.get("token_id")
    if not isinstance(token_id, str) or not token_id:
        raise TrainingExportError(f"{where}: token_id must be a non-empty string")
    if level in ("SOD", "EOD") and token_id != level:
        raise TrainingExportError(
            f"{where}: a {level} token must have token_id {level}"
        )
    # The runner encodes an unknown L0 id as PAD and drops it without a word.
    if level == "L0" and token_id not in L0_CLASSES:
        raise TrainingExportError(
            f"{where}: L0 token_id {token_id!r} is not one of {list(L0_CLASSES)}"
        )

    bucket_idx = token.get("bucket_idx")
    if not _is_int(bucket_idx) or not 0 <= bucket_idx < BUCKETS_PER_DAY:
        raise TrainingExportError(
            f"{where}: bucket_idx must be an integer in [0, {BUCKETS_PER_DAY}), "
            f"got {bucket_idx!r}"
        )

    if "soft_prob" in token:
        soft_prob = token["soft_prob"]
        if not isinstance(soft_prob, list) or not all(
            _is_number(p) and math.isfinite(p) for p in soft_prob
        ):
            raise TrainingExportError(
                f"{where}: soft_prob must be a list of finite numbers"
            )


def _check_day(day: object, where: str) -> list[dict[str, Any]]:
    if not isinstance(day, list) or not day:
        raise TrainingExportError(f"{where}: a day must be a non-empty list of tokens")
    for position, token in enumerate(day):
        _check_token(token, f"{where}, token {position}")
    if day[0]["level"] != "SOD" or day[-1]["level"] != "EOD":
        raise TrainingExportError(
            f"{where}: a day must start with SOD and end with EOD"
        )
    return day


# ── Source ────────────────────────────────────────────────────────────────────


def read_user_sequences(user_id: str, since: date) -> list[list[dict[str, Any]]]:
    """Return one user's serialized days on or after *since*, oldest first.

    Each day is the list of its ``hbpe.token_stream`` rows in ``seq_order``.
    Each row has ``level``, ``token_id``, ``soft_prob`` and ``bucket_idx``.
    Columns come from the table as defined by the HBPE migrations:
    ``(user_id, date, seq_order, bucket_idx, level, token_id, soft_prob)``.

    The reads are the nightly training reads: ``_fetch_dates`` lists the
    user's days and ``TokenStreamDataset`` fetches each day. No new query is
    issued here.
    """
    uid = _parse_user_id(user_id)
    cutoff = since.isoformat()
    dates = [day for day in _fetch_dates(uid) if day >= cutoff]
    return list(TokenStreamDataset(uid, dates))


# ── Writing ───────────────────────────────────────────────────────────────────


def _mapping_or_empty(fields: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    value = fields.get(key)
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise TrainingExportError(f"manifest {key} must be an object, got {value!r}")
    return value


def _complete_manifest(fields: Mapping[str, Any]) -> dict[str, Any]:
    """Caller's manifest fields with run_headless_job's defaults filled in."""
    manifest: dict[str, Any] = dict(fields)
    manifest["hyperparameters"] = {
        **DEFAULT_HYPERPARAMETERS,
        **_mapping_or_empty(fields, "hyperparameters"),
    }
    manifest["resourcePolicy"] = {
        "devicePreference": DEFAULT_DEVICE,
        **_mapping_or_empty(fields, "resourcePolicy"),
    }
    manifest["dataset"] = {
        "valFraction": DEFAULT_VAL_FRACTION,
        **_mapping_or_empty(fields, "dataset"),
    }
    return manifest


def _dataset_text(days: Sequence[list[dict[str, Any]]]) -> str:
    lines: list[str] = []
    for index, day in enumerate(days, start=1):
        try:
            lines.append(json.dumps(day, separators=(",", ":"), allow_nan=False))
        except (TypeError, ValueError) as exc:
            raise TrainingExportError(
                f"day {index} cannot be written as strict JSON: {exc}"
            ) from exc
    return "\n".join(lines) + "\n"


def _manifest_text(manifest: Mapping[str, Any]) -> str:
    try:
        return json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False) + "\n"
    except (TypeError, ValueError) as exc:
        raise TrainingExportError(
            f"manifest fields cannot be written as strict JSON: {exc}"
        ) from exc


def _write_text(path: Path, text: str) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _missing_dirs(path: Path) -> list[Path]:
    """The directories from *path* upward that do not exist yet, nearest first."""
    missing: list[Path] = []
    current = path
    while not current.exists() and current != current.parent:
        missing.append(current)
        current = current.parent
    return missing


def _remove_empty(dirs: Sequence[Path]) -> None:
    """Remove the directories a failed export made, nearest first.

    Stops at the first one that is not empty.
    """
    for directory in dirs:
        try:
            directory.rmdir()
        except OSError:
            return


def _check_target(out: Path, overwrite: bool) -> None:
    """Refuse a target the export cannot replace, before anything is written."""
    if not out.exists():
        return
    if not out.is_dir():
        raise TrainingExportError(f"{out} exists and is not a directory")
    held = sorted(p.name for p in out.iterdir())
    if not held:
        return
    export_names = (DATASET_FILENAME, MANIFEST_FILENAME)
    other = [name for name in held if name not in export_names]
    if other:
        raise TrainingExportError(
            f"{out} holds {', '.join(other)}; an export replaces its directory "
            "as a whole, so choose an empty directory"
        )
    if not overwrite:
        raise TrainingExportError(
            f"{out} already holds {' and '.join(held)}; "
            "pass overwrite=True to replace them"
        )


def _publish(staging: Path, out: Path) -> None:
    """Move the staged directory into place as a whole.

    The dataset and manifest move together, so they appear together or not at
    all. An export being replaced is moved aside first and removed only once
    the new one is in place. If moving the new one in fails, the old one is
    moved back.
    """
    if not out.exists():
        os.replace(staging, out)
        return
    retired = out.parent / f".export-retired-{uuid.uuid4().hex}"
    os.replace(out, retired)
    try:
        os.replace(staging, out)
    except OSError:
        os.replace(retired, out)
        raise
    shutil.rmtree(retired, ignore_errors=True)


def write_training_export(
    sequences: Iterable[list[dict[str, Any]]],
    out_dir: str | Path,
    manifest_fields: Mapping[str, Any],
    *,
    overwrite: bool = False,
) -> TrainingExport:
    """Write ``dataset.jsonl`` and ``manifest.json`` into *out_dir*.

    *sequences* is one list of token dicts per day, in seq_order. Each token
    needs ``level``, ``token_id`` and ``bucket_idx``; ``soft_prob`` is kept
    when present. Nothing is read from the database here.

    *manifest_fields* holds the caller's manifest keys: ``userId`` and
    ``jobId`` are required. ``hyperparameters``, ``resourcePolicy`` and
    ``dataset`` take run_headless_job's defaults for any key left out. Other
    keys, such as ``source`` for provenance, are written as given. The writer
    sets ``dataset.days``, ``dataset.tokens`` and ``dataset.sha256`` itself, so
    any values the caller passes for those three are replaced.

    The export is written only if every check passes. Both files are staged
    beside *out_dir* and re-read, then the staging directory is moved into place
    as a whole, so the dataset and manifest appear together or not at all.
    *out_dir* is created only at that move, and a failed export removes what it
    made. An export already in *out_dir* is replaced only with
    ``overwrite=True``, and only when the directory holds nothing but the two
    export files.
    """
    days = [_check_day(day, f"day {i}") for i, day in enumerate(sequences, start=1)]
    if len(days) < RUNNER_MIN_DAYS:
        raise TrainingExportError(
            f"need at least {RUNNER_MIN_DAYS} days to export, got {len(days)}"
        )

    manifest = _complete_manifest(manifest_fields)
    user_id, job_id = _check_manifest(manifest)  # fails before anything is written

    dataset_text = _dataset_text(days)  # fails before anything is written

    out = Path(out_dir)
    _check_target(out, overwrite)
    tokens = sum(len(day) for day in days)

    created = _missing_dirs(out.parent)
    staging: Path | None = None
    published = False
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        staging = out.parent / f".export-{uuid.uuid4().hex}"
        staging.mkdir()

        staged_dataset = staging / DATASET_FILENAME
        _write_text(staged_dataset, dataset_text)
        manifest["dataset"].update(
            {
                "days": len(days),
                "tokens": tokens,
                "sha256": _sha256(staged_dataset),
            }
        )
        staged_manifest = staging / MANIFEST_FILENAME
        _write_text(staged_manifest, _manifest_text(manifest))

        # Re-read the staged pair with the runner's own loader before it counts.
        validate_training_export(staged_manifest, staged_dataset)

        _publish(staging, out)
        published = True
    finally:
        if not published:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
            _remove_empty(created)

    log.info(
        "exported %d days (%d tokens) for user %s to %s",
        len(days),
        tokens,
        user_id,
        out,
    )
    return TrainingExport(
        manifest_path=out / MANIFEST_FILENAME,
        dataset_path=out / DATASET_FILENAME,
        user_id=user_id,
        job_id=job_id,
        days=len(days),
        tokens=tokens,
    )


# ── Validation ────────────────────────────────────────────────────────────────


def _load_manifest(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as fh:
            manifest = json.load(fh)
    except FileNotFoundError as exc:
        raise TrainingExportError(f"manifest not found: {path}") from exc
    except (OSError, ValueError) as exc:
        raise TrainingExportError(f"manifest {path} is not valid JSON: {exc}") from exc
    if not isinstance(manifest, dict):
        raise TrainingExportError(f"manifest {path} must hold a JSON object")
    return manifest


def validate_training_export(
    manifest_path: str | Path, dataset_path: str | Path
) -> TrainingExport:
    """Re-read an export the way the runner does, and check it.

    The dataset is loaded with ``TokenStreamFileDataset``, the runner's own
    loader. Every day is then checked, and the integrity keys are compared with
    what was read. Raises TrainingExportError on the first problem.
    """
    manifest_file = Path(manifest_path)
    dataset_file = Path(dataset_path)

    manifest = _load_manifest(manifest_file)
    user_id, job_id = _check_manifest(manifest)

    try:
        loaded = TokenStreamFileDataset(dataset_file)
    except FileNotFoundError as exc:
        raise TrainingExportError(f"dataset not found: {dataset_file}") from exc
    except (OSError, ValueError) as exc:
        raise TrainingExportError(
            f"dataset {dataset_file} does not load with the runner's loader: {exc}"
        ) from exc

    days = [loaded[i] for i in range(len(loaded))]
    if len(days) < RUNNER_MIN_DAYS:
        raise TrainingExportError(
            f"dataset has {len(days)} days; the runner needs at least {RUNNER_MIN_DAYS}"
        )
    for index, day in enumerate(days, start=1):
        _check_day(day, f"dataset day {index}")

    tokens = sum(len(day) for day in days)
    integrity = _require_mapping(manifest, "dataset")
    if "sha256" in integrity and integrity["sha256"] != _sha256(dataset_file):
        raise TrainingExportError(
            f"{dataset_file} changed after export: sha256 does not match the manifest"
        )
    if "days" in integrity and integrity["days"] != len(days):
        raise TrainingExportError(
            f"manifest dataset.days is {integrity['days']!r} but the dataset has {len(days)}"
        )
    if "tokens" in integrity and integrity["tokens"] != tokens:
        raise TrainingExportError(
            f"manifest dataset.tokens is {integrity['tokens']!r} but the dataset has {tokens}"
        )

    return TrainingExport(
        manifest_path=manifest_file,
        dataset_path=dataset_file,
        user_id=user_id,
        job_id=job_id,
        days=len(days),
        tokens=tokens,
    )


# ── CLI ───────────────────────────────────────────────────────────────────────


def _user_id_arg(value: str) -> str:
    try:
        return _parse_user_id(value)
    except TrainingExportError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _date_arg(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {value!r}") from exc


def _positive_int_arg(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected an integer, got {value!r}") from exc
    if number < 1:
        raise argparse.ArgumentTypeError(f"expected an integer >= 1, got {number}")
    return number


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m ci.hbpe.model.export_training_dataset",
        description=(
            "Export one user's hbpe.token_stream days as dataset.jsonl and "
            "manifest.json, the inputs ci.hbpe.model.train_runner reads."
        ),
    )
    parser.add_argument(
        "--user-id",
        type=_user_id_arg,
        required=True,
        help="user UUID whose token stream is exported",
    )
    parser.add_argument(
        "--since",
        type=_date_arg,
        required=True,
        help="first day to include, YYYY-MM-DD (inclusive)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        required=True,
        help="directory to write dataset.jsonl and manifest.json into",
    )
    parser.add_argument(
        "--job-id",
        default=None,
        help="jobId written to the manifest (default: a new UUID)",
    )
    parser.add_argument(
        "--epochs",
        type=_positive_int_arg,
        default=DEFAULT_EPOCHS,
        help=f"hyperparameters.epochs (default {DEFAULT_EPOCHS})",
    )
    parser.add_argument(
        "--batch-size",
        type=_positive_int_arg,
        default=DEFAULT_BATCH_SIZE,
        help=f"hyperparameters.batchSize (default {DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--learning-rate",
        type=float,
        default=DEFAULT_LR,
        help=f"hyperparameters.learningRate (default {DEFAULT_LR})",
    )
    parser.add_argument(
        "--val-fraction",
        type=float,
        default=DEFAULT_VAL_FRACTION,
        help=f"dataset.valFraction, in (0, 1) (default {DEFAULT_VAL_FRACTION})",
    )
    parser.add_argument(
        "--device",
        default=DEFAULT_DEVICE,
        help="resourcePolicy.devicePreference: auto, cpu, mps or cuda[:N]",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help=(
            "replace the export in --out-dir; the directory may hold only "
            "dataset.jsonl and manifest.json"
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    fields: dict[str, Any] = {
        "userId": args.user_id,
        "jobId": args.job_id or str(uuid.uuid4()),
        "hyperparameters": {
            "batchSize": args.batch_size,
            "epochs": args.epochs,
            "learningRate": args.learning_rate,
        },
        "resourcePolicy": {"devicePreference": args.device},
        "dataset": {"valFraction": args.val_fraction},
        "source": {
            "table": "hbpe.token_stream",
            "since": args.since.isoformat(),
        },
    }
    try:
        sequences = read_user_sequences(args.user_id, args.since)
        export = write_training_export(
            sequences, args.out_dir, fields, overwrite=args.overwrite
        )
    except (TrainingExportError, OSError, psycopg2.Error) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(
        f"exported {export.days} days ({export.tokens} tokens) "
        f"for user {export.user_id}, job {export.job_id}"
    )
    print(f"manifest: {export.manifest_path}")
    print(f"dataset:  {export.dataset_path}")
    print(
        "run: python -m ci.hbpe.model.train_runner "
        f"--manifest {export.manifest_path} --dataset {export.dataset_path} "
        "--output <artifacts-dir>"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
