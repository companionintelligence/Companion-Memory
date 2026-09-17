#!/usr/bin/env python3
"""Create a portable macOS activity snapshot without moving Apple's databases."""

import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
import time
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

SOURCES = {
    "knowledge": "Library/Application Support/Knowledge/knowledgeC.db",
    "safari": "Library/Safari/History.db",
    "calls": "Library/Application Support/CallHistoryDB/CallHistory.storedata",
}
MANIFEST = "macos-activity.json"


def snapshot(source: Path, destination: Path, timeout: float = 30) -> None:
    """SQLite's backup API includes committed WAL pages in one consistent copy."""
    deadline = time.monotonic() + timeout

    def progress(_status: int, _remaining: int, _total: int) -> None:
        if time.monotonic() > deadline:
            raise TimeoutError(
                "Snapshot timed out; try again when the database is idle"
            )

    # No immutable=1: that would ignore the live database's WAL.
    with closing(
        sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)
    ) as src:
        with closing(sqlite3.connect(destination)) as dst:
            src.backup(dst, pages=256, progress=progress, sleep=0.05)
            # Ship a standalone database, without requiring WAL/SHM sidecars.
            dst.execute("PRAGMA journal_mode=DELETE")
    destination.chmod(0o600)


def export_activity(
    home: Path, output: Path, device_id: str, sources: list[str]
) -> dict:
    """Publish a new directory atomically; preserve per-source acquisition failures."""
    if output.exists():
        raise FileExistsError(
            "Output already exists; choose a fresh snapshot directory"
        )
    if not device_id.strip():
        raise ValueError("A stable, nonempty device ID is required")
    if (
        not sources
        or len(set(sources)) != len(sources)
        or any(s not in SOURCES for s in sources)
    ):
        raise ValueError("Select distinct supported sources")

    output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "format": "ci-macos-activity",
        "version": 1,
        "deviceId": hashlib.sha256(device_id.encode()).hexdigest(),
        "exportedAt": datetime.now(UTC).isoformat(),
        "sources": [],
    }
    # Hidden while in progress so an inbox scanner cannot consume half a snapshot.
    with tempfile.TemporaryDirectory(
        prefix=".macos-activity-", dir=output.parent
    ) as work:
        work_path = Path(work)
        for name in sources:
            destination = work_path / f"{name}.sqlite"
            try:
                snapshot(home / SOURCES[name], destination)
                result = {"name": name, "status": "ok"}
            except (OSError, sqlite3.Error) as exc:
                for leftover in work_path.glob(f"{name}.sqlite*"):
                    leftover.unlink()
                result = {"name": name, "status": "unavailable", "error": str(exc)}
            report["sources"].append(result)

        manifest = work_path / MANIFEST
        manifest.write_text(json.dumps(report, indent=2) + "\n")
        manifest.chmod(0o600)
        # Never replace a prior export (including one created during acquisition).
        if output.exists():
            raise FileExistsError("Output was created during acquisition")
        work_path.rename(output)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--home",
        type=Path,
        default=Path.home(),
        help="macOS account home or mounted copy",
    )
    parser.add_argument(
        "--output", required=True, type=Path, help="New snapshot directory to upload"
    )
    parser.add_argument(
        "--device-id",
        required=True,
        help="Stable label for this Mac/account; reuse on each run",
    )
    parser.add_argument("--sources", nargs="+", choices=SOURCES, default=list(SOURCES))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        report = export_activity(args.home, args.output, args.device_id, args.sources)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"{exc}\n")
    for source in report["sources"]:
        print(f"{source['name']}: {source['status']}")
    print(f"Snapshot: {args.output}")
    if any(source["status"] != "ok" for source in report["sources"]):
        print(
            "Some sources were unavailable. Review macos-activity.json; protected sources may need Full Disk Access."
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
