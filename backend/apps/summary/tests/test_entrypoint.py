"""The container entrypoint stops when either of its two services dies."""

from __future__ import annotations

import os
import stat
import subprocess
import time
from pathlib import Path

ENTRYPOINT = Path(__file__).resolve().parents[1] / "entrypoint.sh"

# Stands in for uvicorn: the app named on the command line decides what it does.
FAKE_UVICORN = """#!/bin/sh
echo $$ > "$FAKE_DIR/$1.pid"
case "$1" in
  "$FAKE_EXITS") sleep 0.5; exit "$FAKE_STATUS" ;;
  *) exec sleep 30 ;;
esac
"""


def _run(
    tmp_path: Path, exits: str, status: int
) -> tuple[subprocess.CompletedProcess[str], float]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "uvicorn"
    fake.write_text(FAKE_UVICORN)
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)

    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "SECRETS_FILE": str(tmp_path / "absent"),
        "DATABASE_URL": "postgresql://u:p@localhost:5432/db",
        "SIDECAR_AUTH_SECRET": "s3cret",
        "FAKE_DIR": str(tmp_path),
        "FAKE_EXITS": exits,
        "FAKE_STATUS": str(status),
    }
    started = time.monotonic()
    result = subprocess.run(
        ["bash", str(ENTRYPOINT)], env=env, capture_output=True, text=True, timeout=20
    )
    return result, time.monotonic() - started


def _alive(pid_file: Path) -> bool:
    try:
        os.kill(int(pid_file.read_text().strip()), 0)
    except (ProcessLookupError, ValueError):
        return False
    return True


def test_a_dead_parser_takes_the_container_down(tmp_path: Path) -> None:
    result, elapsed = _run(tmp_path, "ci.summary.parser:app", 137)

    assert result.returncode == 137
    assert elapsed < 10  # not the summary API's 30 s
    assert "exited (status 137)" in result.stderr
    assert not _alive(tmp_path / "ci.summary.api:app.pid")


def test_a_service_that_exits_cleanly_still_fails_the_container(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, "ci.summary.api:app", 0)

    # A server has no business exiting 0; Docker must see a failure to restart it.
    assert result.returncode == 1
    assert not _alive(tmp_path / "ci.summary.parser:app.pid")
