#!/usr/bin/env python3
"""Consistent Docker appliance snapshots, verified restore and scheduled backups.

No database passwords or object-store credentials are read into command lines.
The snapshot contains secrets: store it on an encrypted, access-controlled disk.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path, PurePosixPath
from typing import Any

# Not datetime.UTC: that alias needs Python 3.11, and this script runs on the host's own Python.
UTC = dt.timezone.utc  # noqa: UP017
SCHEMA = 1
DATA_PATHS = {
    "/var/lib/postgresql",
    "/var/lib/postgresql/data",
    "/data/objects",
    "/run/secrets",
    "/app/data",
    "/app/models",
    "/var/lib/ci-import",
}
NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
PUBLIC_STATUS_KEYS = {
    "project",
    "state",
    "last_success_at",
    "last_failure_at",
    "bytes",
    "coverage",
}


def docker(*args: str, **kwargs: Any) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], check=True, **kwargs)


def docker_json(*args: str) -> Any:
    return json.loads(
        docker(*args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout
    )


def containers(project: str) -> list[dict[str, Any]]:
    ids = docker(
        "ps",
        "-aq",
        "--filter",
        f"label=com.docker.compose.project={project}",
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.split()
    if not ids:
        raise ValueError(
            f"No Docker containers for project {project}; create the target stack first."
        )
    return docker_json("inspect", *ids)


def all_containers() -> list[dict[str, Any]]:
    ids = docker("ps", "-aq", stdout=subprocess.PIPE, text=True).stdout.split()
    return docker_json("inspect", *ids) if ids else []


def assert_unshared_mounts(
    items: list[dict[str, Any]], mounts: list[dict[str, Any]]
) -> None:
    own_ids = {container["Id"] for container in items}
    sources = {entry["mount"]["Source"] for entry in mounts}
    for container in all_containers():
        if container["Id"] not in own_ids and any(
            mount.get("Source") in sources for mount in container.get("Mounts", [])
        ):
            raise ValueError(
                "A data mount is shared with another project; backup or restore refused."
            )


def assert_separate_destination(root: Path, mounts: list[dict[str, Any]]) -> None:
    for entry in mounts:
        source = Path(entry["mount"]["Source"])
        if source.is_absolute():
            source = source.resolve()
            if root == source or source in root.parents:
                raise ValueError(
                    "Backup destination must not be inside a captured data store."
                )


def service(container: dict[str, Any]) -> str:
    return container["Config"]["Labels"]["com.docker.compose.service"]


def data_mounts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Archive each persistent store once, preferring its writable mount."""
    selected: dict[tuple[str, str], dict[str, Any]] = {}
    # By service name, not in Docker's listing order. A volume shared by two containers (api and
    # worker both mount the import working area) is recorded under the first one seen, and a
    # restore target lists its containers in whatever order Docker happens to return them.
    for container in sorted(items, key=service):
        for mount in container.get("Mounts", []):
            dest = mount["Destination"].rstrip("/")
            if mount["Type"] not in {"volume", "bind"}:
                continue
            # Named volumes are deployment data. Bind mounts must be a known
            # data directory: never capture /repo (the owner's original exports),
            # source code, Docker's socket, or unrelated host files.
            if mount["Type"] == "bind" and not any(
                dest == p or dest.startswith(p + "/") for p in DATA_PATHS
            ):
                continue
            if (
                mount["Type"] == "volume"
                and dest == "/data"
                and any(
                    m["Destination"].startswith("/data/")
                    for m in container.get("Mounts", [])
                )
            ):
                # Upstream images can declare an unused /data anonymous volume;
                # the actual object store is separately mounted at /data/objects.
                continue
            key = (mount["Type"], mount["Source"])
            entry = {
                "service": service(container),
                "destination": dest,
                "container_id": container["Id"],
                "image": container["Config"]["Image"],
                "image_id": container["Image"],
                "mount": mount,
            }
            if key not in selected or (
                mount.get("RW") and not selected[key]["mount"].get("RW")
            ):
                selected[key] = entry
    result = sorted(selected.values(), key=lambda m: (m["service"], m["destination"]))
    if not any(m["service"] == "database" for m in result):
        raise ValueError(
            "No database data mount found; refusing an incomplete snapshot."
        )
    if not any(m["service"] == "object-store" for m in result):
        raise ValueError(
            "No object-store data mount found; refusing a snapshot without uploaded files."
        )
    return result


def safe_project(value: str) -> str:
    if not NAME.fullmatch(value):
        raise ValueError("Project must be a Docker Compose project name.")
    return value


def destination(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("Backup destination must be absolute.")
    path = path.resolve()
    repo = Path(__file__).resolve().parents[2]
    if (
        path in {Path("/"), Path.home().resolve()}
        or path == repo
        or repo in path.parents
    ):
        raise ValueError(
            "Use a dedicated backup directory outside the checkout and home root."
        )
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


@contextlib.contextmanager
def lock(directory: Path, project: str) -> Iterator[None]:
    with (directory / f".{project}.lock").open("a") as handle:
        os.chmod(handle.name, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError(
                f"A backup or restore for {project} is already running."
            ) from exc
        yield


def atomic_json(path: Path, value: Any, *, mode: int = 0o600) -> None:
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def prepare_status_directory(path: Path | None, root: Path) -> Path | None:
    if path is None:
        return None
    path = path.expanduser()
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("Status directory must be an absolute, real directory.")
    path = path.resolve()
    root = root.resolve()
    if path == root or path in root.parents or root in path.parents:
        raise ValueError(
            "Use a dedicated status directory separate from the backup directory."
        )
    existed = path.exists()
    path.mkdir(parents=True, exist_ok=True, mode=0o755)
    if not existed:
        os.chmod(path, 0o755)
    for child in path.iterdir():
        if (
            child.is_symlink()
            or not child.is_file()
            or not child.name.endswith(".status.json")
        ):
            raise ValueError(
                "Status directory may contain only sanitized status JSON files."
            )
        value = json.loads(child.read_text())
        if not isinstance(value, dict) or set(value) - PUBLIC_STATUS_KEYS:
            raise ValueError(
                "Status directory may contain only sanitized status JSON files."
            )
    return path


def write_status(
    root: Path, project: str, value: dict[str, Any], status_directory: Path | None
) -> None:
    atomic_json(root / f"{project}.status.json", value)
    if status_directory is not None:
        atomic_json(
            status_directory / f"{project}.status.json",
            {key: value[key] for key in PUBLIC_STATUS_KEYS if key in value},
            mode=0o644,
        )


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


@contextlib.contextmanager
def stopped(
    items: list[dict[str, Any]], *, restart_on_failure: bool = True
) -> Iterator[None]:
    running = [c["Id"] for c in items if c["State"]["Running"]]
    halted: list[str] = []
    succeeded = False
    try:
        # Include the object store and database: these are raw volume snapshots,
        # so every writer must stop, not just the web app. Stop the database last.
        ordered = sorted(
            running,
            key=lambda ident: next(
                service(c) == "database" for c in items if c["Id"] == ident
            ),
        )
        for ident in ordered:
            # Register before stopping so interruption still restores this process.
            halted.append(ident)
            docker("stop", "--time", "60", ident, stdout=subprocess.DEVNULL)
        yield
        succeeded = True
    finally:
        if not succeeded and not restart_on_failure:
            print(
                "Restore incomplete: target remains stopped. Correct the failure and retry the full restore.",
                file=sys.stderr,
            )
        failures = []
        # Start database first; only restart containers that were running before.
        for ident in reversed(halted) if succeeded or restart_on_failure else []:
            try:
                docker("start", ident, stdout=subprocess.DEVNULL)
            except subprocess.CalledProcessError:
                failures.append(ident[:12])
        if failures:
            raise RuntimeError(
                "Could not restart original containers: " + ", ".join(failures)
            )


def validate_tar(path: Path) -> None:
    # Docker creates the archive, but restore must also reject a modified or
    # untrusted snapshot. Permit only members and links confined to the mount.
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise ValueError("Snapshot contains an unsafe archive path.")
            if member.isdev() or member.isfifo():
                raise ValueError("Snapshot contains a device or pipe.")
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                # Refuse any parent reference, even one that might normalize
                # inside the mount: PostgreSQL tablespaces outside the volume
                # require an explicitly managed backup rather than guessed links.
                if target.is_absolute() or ".." in target.parts:
                    raise ValueError(
                        "Snapshot contains an external link; back up its target separately."
                    )
        # tarfile can stop at its footer before gzip's CRC. Drain the compressed
        # stream separately so a corrupt trailer is rejected as well.
    with gzip.open(path, "rb") as handle:
        while handle.read(1024 * 1024):
            pass


def capture(entry: dict[str, Any], target: Path) -> None:
    process = subprocess.Popen(
        ["docker", "cp", f"{entry['container_id']}:{entry['destination']}/.", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdout is not None
    try:
        with gzip.open(target, "wb", compresslevel=1) as handle:
            shutil.copyfileobj(process.stdout, handle, length=1024 * 1024)
        _, error = process.communicate()
        if process.returncode:
            raise RuntimeError(
                "Could not archive "
                + entry["service"]
                + ": "
                + error.decode(errors="replace")
            )
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()
    validate_tar(target)


def backup(
    project: str,
    root: Path,
    secrets_file: Path | None = None,
    *,
    status_directory: Path | None = None,
) -> Path:
    project = safe_project(project)
    root = root.resolve()
    status_directory = prepare_status_directory(status_directory, root)
    with lock(root, project):
        stamp = dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
        partial = root / f".{project}-{stamp}.partial"
        complete = root / f"{project}-{stamp}"
        try:
            items = containers(project)
            mounts = data_mounts(items)
            assert_separate_destination(root, mounts)
            assert_unshared_mounts(items, mounts)
            if secrets_file is not None:
                if not secrets_file.is_file() or secrets_file.is_symlink():
                    raise ValueError("Deployment secrets must be a real file.")
                if not re.search(
                    r"(?m)^AUTH_FIELD_ENCRYPTION_KEY=.+$", secrets_file.read_text()
                ):
                    raise ValueError(
                        "Deployment secrets do not contain AUTH_FIELD_ENCRYPTION_KEY."
                    )
            partial.mkdir(mode=0o700)
            manifest: dict[str, Any] = {
                "schema": SCHEMA,
                "project": project,
                "created_at": stamp,
                "consistent": True,
                "requires_matching_storage_images": True,
                "coverage": "database, uploaded files, secrets and all persistent Docker volumes; known data bind mounts",
                "excluded": [
                    "read-only source archives (/repo)",
                    "source code",
                    "unmounted deployment environment files",
                ],
                "mounts": [],
            }
            with stopped(items):
                for index, entry in enumerate(mounts):
                    filename = f"{index:03d}.tar.gz"
                    capture(entry, partial / filename)
                    manifest["mounts"].append(
                        {
                            "service": entry["service"],
                            "destination": entry["destination"],
                            "image": entry["image"],
                            "image_id": entry["image_id"],
                            "archive": filename,
                            "sha256": digest(partial / filename),
                            "bytes": (partial / filename).stat().st_size,
                        }
                    )
                has_master = False
                for entry in manifest["mounts"]:
                    if (
                        entry["service"] in {"generate-secrets", "setup-secrets"}
                        and entry["destination"] == "/run/secrets"
                    ):
                        with tarfile.open(
                            partial / entry["archive"], "r:gz"
                        ) as archive:
                            for member in archive:
                                if member.isfile() and PurePosixPath(
                                    member.name
                                ) == PurePosixPath(".env.secrets"):
                                    handle = archive.extractfile(member)
                                    if handle is not None and re.search(
                                        rb"(?m)^AUTH_FIELD_ENCRYPTION_KEY=.+$",
                                        handle.read(),
                                    ):
                                        has_master = True
                if secrets_file is not None:
                    shutil.copyfile(secrets_file, partial / "deployment.env")
                    os.chmod(partial / "deployment.env", 0o600)
                    manifest["deployment_env"] = {
                        "file": "deployment.env",
                        "sha256": digest(partial / "deployment.env"),
                    }
                if not has_master and secrets_file is None:
                    raise ValueError(
                        "No master encryption key was found. Pass --secrets-file with this deployment's complete environment file."
                    )
                manifest["encryption_root_included"] = True
                atomic_json(partial / "manifest.json", manifest)
            partial.rename(complete)
            write_status(
                root,
                project,
                {
                    "project": project,
                    "state": "complete",
                    "last_success_at": dt.datetime.now(UTC).isoformat(),
                    "snapshot": complete.name,
                    "bytes": sum(m["bytes"] for m in manifest["mounts"]),
                    "coverage": manifest["coverage"],
                },
                status_directory,
            )
            return complete
        except BaseException as exc:
            old: dict[str, Any] = {}
            status = root / f"{project}.status.json"
            if status.exists():
                old = json.loads(status.read_text())
            write_status(
                root,
                project,
                {
                    **old,
                    "project": project,
                    "state": "failed",
                    "last_failure_at": dt.datetime.now(UTC).isoformat(),
                    "error": type(exc).__name__ + ": " + str(exc),
                },
                status_directory,
            )
            if partial.exists():
                shutil.rmtree(partial)
            raise


def load_manifest(snapshot: Path) -> dict[str, Any]:
    if snapshot.is_symlink() or not snapshot.is_dir():
        raise ValueError("Snapshot must be a real directory.")
    manifest_path = snapshot / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("Snapshot manifest must not be a symlink.")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema") != SCHEMA or manifest.get("consistent") is not True:
        raise ValueError("Unsupported or incomplete snapshot.")
    mounts = manifest.get("mounts")
    if not isinstance(mounts, list) or not mounts:
        raise ValueError("Snapshot has no data archives.")
    if not any(m.get("service") == "database" for m in mounts) or not any(
        m.get("service") == "object-store" for m in mounts
    ):
        raise ValueError("Snapshot omits the database or uploaded files.")
    if manifest.get("encryption_root_included") is not True:
        raise ValueError("Snapshot lacks the encryption root.")
    if "deployment_env" in manifest:
        env = manifest["deployment_env"]
        env_path = snapshot / "deployment.env"
        if (
            env.get("file") != "deployment.env"
            or env_path.is_symlink()
            or not env_path.is_file()
            or digest(env_path) != env.get("sha256")
        ):
            raise ValueError("Deployment environment file failed its checksum.")
    seen = set()
    for entry in mounts:
        filename = entry["archive"]
        if (
            not isinstance(filename, str)
            or not re.fullmatch(r"[0-9]{3}\.tar\.gz", filename)
            or filename in seen
        ):
            raise ValueError("Invalid or duplicated archive filename.")
        seen.add(filename)
        path = snapshot / filename
        if path.is_symlink() or not path.is_file() or digest(path) != entry["sha256"]:
            raise ValueError("Snapshot archive is missing or failed its checksum.")
        validate_tar(path)
    return manifest


def restore(
    project: str, snapshot: Path, confirm: str, *, environment_restored: bool = False
) -> None:
    project = safe_project(project)
    if confirm != project:
        raise ValueError(
            "Restore replaces target data. Pass --confirm-project with the exact target project name."
        )
    with lock(snapshot.parent, project):
        # Validate every byte BEFORE stopping anything or replacing target data.
        manifest = load_manifest(snapshot)
        items = containers(project)
        targets = {(m["service"], m["destination"]): m for m in data_mounts(items)}
        plan = []
        for entry in manifest["mounts"]:
            target = targets.get((entry["service"], entry["destination"]))
            if not target:
                raise ValueError(
                    f"Target has no data mount for {entry['service']}:{entry['destination']}."
                )
            if (
                entry["service"] in {"database", "object-store"}
                and target["image_id"] != entry["image_id"]
            ):
                raise ValueError(
                    "Storage image differs from snapshot. Recreate target with the recorded image before restoring."
                )
            plan.append((entry, target))
        planned_keys = {(entry["service"], entry["destination"]) for entry, _ in plan}
        if planned_keys != set(targets):
            raise ValueError(
                "Target persistent stores differ from the snapshot; recreate the matching deployment before restoring."
            )
        # A target volume must not also be used by an unrelated appliance.
        assert_unshared_mounts(items, [target for _, target in plan])
        helper_image = next(
            m["image_id"] for _, m in plan if m["service"] == "database"
        )
        # Environment-based deployments must restore this file before boot;
        # require an explicit target path instead of guessing where .env lives.
        if "deployment_env" in manifest and not environment_restored:
            raise ValueError(
                "This snapshot includes deployment.env. Restore it to the deployment environment path, then use --environment-restored to acknowledge before restoring data."
            )
        with stopped(items, restart_on_failure=False):
            for entry, target in plan:
                mount = target["mount"]
                mount_spec = (
                    f"type=volume,src={mount['Name']},dst=/restore-data"
                    if mount["Type"] == "volume"
                    else f"type=bind,src={mount['Source']},dst=/restore-data"
                )
                if "," in (mount.get("Name") or mount["Source"]):
                    raise ValueError("Target mount path contains unsupported comma.")
                docker(
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--user",
                    "0:0",
                    "--mount",
                    mount_spec,
                    "--entrypoint",
                    "/bin/sh",
                    helper_image,
                    "-c",
                    "find /restore-data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
                    stdout=subprocess.DEVNULL,
                )
                with gzip.open(snapshot / entry["archive"], "rb") as source:
                    process = subprocess.Popen(
                        [
                            "docker",
                            "run",
                            "--rm",
                            "-i",
                            "--network",
                            "none",
                            "--user",
                            "0:0",
                            "--mount",
                            mount_spec,
                            "--entrypoint",
                            "tar",
                            helper_image,
                            "-xf",
                            "-",
                            "-C",
                            "/restore-data",
                        ],
                        stdin=subprocess.PIPE,
                    )
                    assert process.stdin is not None
                    try:
                        shutil.copyfileobj(source, process.stdin, length=1024 * 1024)
                        process.stdin.close()
                        if process.wait():
                            raise RuntimeError("Failed restoring " + entry["service"])
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.wait()


def prune(root: Path, project: str, keep: int) -> None:
    snapshots = []
    for path in root.glob(f"{project}-*"):
        if (
            path.is_dir()
            and not path.is_symlink()
            and (path / "manifest.json").is_file()
        ):
            try:
                manifest = json.loads((path / "manifest.json").read_text())
                if (
                    manifest.get("schema") == SCHEMA
                    and manifest.get("project") == project
                ):
                    snapshots.append(path)
            except (OSError, ValueError):
                continue
    for path in sorted(snapshots, reverse=True)[keep:]:
        shutil.rmtree(path)


def default_project() -> str:
    value = os.environ.get("COMPOSE_PROJECT_NAME", "")
    if not value:
        raise ValueError(
            "Pass --project NAME or set COMPOSE_PROJECT_NAME; no guessed appliance target."
        )
    return value


def update_options(values: list[str]) -> list[str]:
    """Accept deployment selection options, never a second Compose action."""
    values = values[1:] if values and values[0] == "--" else values
    allowed = {"-f", "--file", "--profile", "--env-file", "--project-directory"}
    result: list[str] = []
    has_file = False
    index = 0
    while index < len(values):
        option, separator, inline = values[index].partition("=")
        if option not in allowed:
            raise ValueError(
                "Update accepts only Compose --file, --profile, --env-file and --project-directory options."
            )
        if separator:
            value = inline
        else:
            index += 1
            value = values[index] if index < len(values) else ""
        if not value or value.startswith("-"):
            raise ValueError(f"Compose option {option} requires a value.")
        has_file = has_file or option in {"-f", "--file"}
        result.extend([option, value])
        index += 1
    if not has_file:
        raise ValueError("Update requires explicit Compose --file options after --.")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["backup", "serve", "update"]:
        command = commands.add_parser(
            name,
            help="Complete consistent snapshot"
            if name == "backup"
            else "Run scheduled backups",
        )
        command.add_argument(
            "--project", default=os.environ.get("COMPOSE_PROJECT_NAME")
        )
        command.add_argument("destination")
        command.add_argument(
            "--secrets-file",
            type=Path,
            help="Required for deployments whose encryption root is in a host environment file",
        )
        command.add_argument(
            "--status-directory",
            type=Path,
            help="Publish sanitized status in a dedicated directory for a read-only API mount",
        )
        if name == "update":
            command.add_argument(
                "compose_args",
                nargs=argparse.REMAINDER,
                help="Compose options after --, for example -f docker-compose.yml -f docker-compose.production.yml --profile production",
            )
        if name == "serve":
            command.add_argument("--interval-hours", type=float, default=24)
            command.add_argument("--keep", type=int, default=7)
    command = commands.add_parser(
        "restore", help="Replace a prepared target with a verified snapshot"
    )
    command.add_argument("--project", required=True)
    command.add_argument("--confirm-project", required=True)
    command.add_argument("snapshot", type=Path)
    command.add_argument(
        "--environment-restored",
        action="store_true",
        help="Acknowledge restoring snapshot deployment.env before boot",
    )
    command = commands.add_parser(
        "verify", help="Verify archive checksums and confinement without restoring"
    )
    command.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == "verify":
            manifest = load_manifest(args.snapshot)
            print(
                f"Verified {len(manifest['mounts'])} data archives; restore drill still required."
            )
        elif args.command == "restore":
            restore(
                args.project,
                args.snapshot.absolute(),
                args.confirm_project,
                environment_restored=args.environment_restored,
            )
            print(
                "Restored verified snapshot. Check login, search and uploaded files before resuming use."
            )
        else:
            project = safe_project(args.project or default_project())
            compose_args = (
                update_options(args.compose_args) if args.command == "update" else []
            )
            root = destination(args.destination)
            if args.command == "serve" and (
                not math.isfinite(args.interval_hours)
                or args.interval_hours < 1
                or args.keep < 1
            ):
                raise ValueError(
                    "Scheduled interval and retained snapshot count must be at least 1."
                )
            while True:
                try:
                    snapshot = backup(
                        project,
                        root,
                        args.secrets_file,
                        status_directory=args.status_directory,
                    )
                    print("Snapshot complete:", snapshot, flush=True)
                    if args.command == "update":
                        try:
                            docker(
                                "compose",
                                "--project-name",
                                project,
                                *compose_args,
                                "pull",
                            )
                            docker(
                                "compose",
                                "--project-name",
                                project,
                                *compose_args,
                                "up",
                                "-d",
                                "--wait",
                                "--wait-timeout",
                                "180",
                            )
                        except subprocess.CalledProcessError as exc:
                            raise RuntimeError(
                                f"Update did not pass health checks. Complete snapshot retained at {snapshot}; restore with its recorded storage images before retrying."
                            ) from exc
                    if args.command == "serve":
                        prune(root, project, args.keep)
                except Exception:
                    if args.command != "serve":
                        raise
                    print(
                        "Scheduled backup failed; see project status file. Previous successful snapshots retained.",
                        file=sys.stderr,
                        flush=True,
                    )
                if args.command != "serve":
                    break
                time.sleep(args.interval_hours * 3600)
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print("Error:", exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
