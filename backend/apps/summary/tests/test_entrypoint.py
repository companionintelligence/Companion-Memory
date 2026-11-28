"""The container entrypoint stops when either of its two services dies."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "entrypoint.sh"

# entrypoint.sh waits with `wait -n`, which needs bash 4.3 or newer. It is the
# summary image's CMD and runs under that container's bash 5. macOS's /bin/bash
# is 3.2 and refuses the flag ("wait: -n: invalid option"), so on a Mac whose
# PATH reaches /bin/bash first these tests fail. They skip on every darwin run,
# including a Mac with a newer bash first on PATH, rather than depend on which
# `bash` the subprocess finds. Linux is never skipped; CI runs them there.
_needs_wait_n = pytest.mark.skipif(
    sys.platform == "darwin",
    reason=(
        "entrypoint.sh uses `wait -n` (bash 4.3+), which macOS's /bin/bash 3.2 "
        "lacks. It is the summary container's CMD and runs under bash 5 there; "
        "Linux CI runs these tests."
    ),
)

# Stands in for uvicorn: the app named on the command line decides what it does.
FAKE_UVICORN = """#!/bin/sh
echo $$ > "$FAKE_DIR/$1.pid"
env > "$FAKE_DIR/$1.env"
case "$1" in
  "$FAKE_EXITS") sleep 0.5; exit "$FAKE_STATUS" ;;
  *) exec sleep 30 ;;
esac
"""


def _run(
    tmp_path: Path, exits: str, status: int, extra_env: dict[str, str] | None = None
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
        **(extra_env or {}),
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


@_needs_wait_n
def test_a_dead_parser_takes_the_container_down(tmp_path: Path) -> None:
    result, elapsed = _run(tmp_path, "ci.summary.parser:app", 137)

    assert result.returncode == 137
    assert elapsed < 10  # not the summary API's 30 s
    assert "exited (status 137)" in result.stderr
    assert not _alive(tmp_path / "ci.summary.api:app.pid")


@_needs_wait_n
def test_a_service_that_exits_cleanly_still_fails_the_container(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, "ci.summary.api:app", 0)

    # A server has no business exiting 0; Docker must see a failure to restart it.
    assert result.returncode == 1
    assert not _alive(tmp_path / "ci.summary.parser:app.pid")


def _env_of(tmp_path: Path, app: str) -> dict[str, str]:
    lines = (tmp_path / f"{app}.env").read_text().splitlines()
    return dict(line.split("=", 1) for line in lines if "=" in line)


# The parser reads documents whoever made them chose. Run on its own it must hold nothing that
# reaches the database or the summary service.
def test_the_parser_role_starts_only_the_parser_with_no_database_or_summary_bearer(
    tmp_path: Path,
) -> None:
    result, _ = _run(
        tmp_path,
        "ci.summary.parser:app",
        0,
        {
            "SUMMARY_ROLE": "parser",
            "PARSER_AUTH_SECRET": "parser-s3cret",
            "DATABASE_PASSWORD": "db-password",
            "DATABASE_USERNAME": "companion",
        },
    )

    assert result.returncode == 0, result.stderr
    env = _env_of(tmp_path, "ci.summary.parser:app")
    assert env["PARSER_AUTH_SECRET"] == "parser-s3cret"
    for name in (
        "DATABASE_URL",
        "DATABASE_PASSWORD",
        "DATABASE_USERNAME",
        "SIDECAR_AUTH_SECRET",
    ):
        assert name not in env, name
    assert not (tmp_path / "ci.summary.api:app.pid").exists()


def test_the_parser_role_refuses_to_start_without_its_bearer(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, "ci.summary.parser:app", 0, {"SUMMARY_ROLE": "parser"})

    assert result.returncode == 1
    assert "PARSER_AUTH_SECRET is not set" in result.stdout
    assert not (tmp_path / "ci.summary.parser:app.pid").exists()


def test_the_summary_role_starts_only_the_summary_api(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, "ci.summary.api:app", 0, {"SUMMARY_ROLE": "summary"})

    assert result.returncode == 0, result.stderr
    assert _env_of(tmp_path, "ci.summary.api:app")["DATABASE_URL"].startswith(
        "postgresql://"
    )
    assert not (tmp_path / "ci.summary.parser:app.pid").exists()


def test_an_unknown_role_is_refused(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, "ci.summary.api:app", 0, {"SUMMARY_ROLE": "everything"})

    assert result.returncode == 1
    assert "SUMMARY_ROLE must be" in result.stdout
