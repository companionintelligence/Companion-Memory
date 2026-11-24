"""Opt-in real Docker drill: PostgreSQL row + uploaded bytes + encryption root.

RUN_DOCKER_RECOVERY_TESTS=1 python3 -m unittest discover -s scripts/backup/tests
Creates only labelled fixture containers/volumes, then removes all of them.
"""

import importlib.util
import os
import secrets
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "recovery", Path(__file__).parents[1] / "appliance-recovery.py"
)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


@unittest.skipUnless(
    os.environ.get("RUN_DOCKER_RECOVERY_TESTS") == "1",
    "opt-in real Docker restore drill",
)
class DockerRestoreDrill(unittest.TestCase):
    def command(self, *args, input=None):
        return subprocess.run(
            ["docker", *args],
            input=input,
            capture_output=True,
            check=True,
        ).stdout

    def setUp(self):
        self.suffix = secrets.token_hex(4)
        self.source = "memory-recovery-source-" + self.suffix
        self.target = "memory-recovery-target-" + self.suffix
        self.created = []
        self.volumes = []
        self.addCleanup(self.cleanup)
        self.temp = tempfile.TemporaryDirectory(prefix="memory-restore-drill-")
        self.addCleanup(self.temp.cleanup)
        for project in [self.source, self.target]:
            for service, mount, image in [
                (
                    "database",
                    "/var/lib/postgresql",
                    os.environ.get("CI_RECOVERY_DATABASE_IMAGE", "ci/database:latest"),
                ),
                ("object-store", "/data/objects", "alpine:3.21"),
                ("generate-secrets", "/run/secrets", "alpine:3.21"),
            ]:
                name = project + "-" + service
                volume = name + "-data"
                self.command(
                    "volume", "create", "--label", "ci.recovery-drill=1", volume
                )
                self.volumes.append(volume)
                args = [
                    "create",
                    "--name",
                    name,
                    "--label",
                    "ci.recovery-drill=1",
                    "--label",
                    "com.docker.compose.project=" + project,
                    "--label",
                    "com.docker.compose.service=" + service,
                    "--mount",
                    f"type=volume,src={volume},dst={mount}",
                ]
                if service == "database":
                    args.extend(["-e", "PASSWORD=" + secrets.token_hex(24), image])
                else:
                    args.extend([image, "sleep", "3600"])
                self.command(*args)
                self.created.append(name)
                if project == self.source:
                    self.command("start", name)
        db = self.source + "-database"
        for _ in range(60):
            probe = subprocess.run(
                ["docker", "exec", db, "pg_isready", "-U", "postgres"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if probe.returncode == 0:
                break
            time.sleep(0.5)
        else:
            self.fail("fixture PostgreSQL did not become ready")
        self.command(
            "exec",
            db,
            "psql",
            "-U",
            "postgres",
            "-c",
            "CREATE TABLE recovery_fixture (id int primary key, text text); INSERT INTO recovery_fixture VALUES (1, 'restored memory');",
        )
        self.command(
            "exec",
            "-i",
            self.source + "-object-store",
            "sh",
            "-c",
            "cat > /data/objects/attachment.bin",
            input=b"synthetic uploaded file\x00\x01",
        )
        self.key = secrets.token_hex(32)
        self.command(
            "exec",
            "-i",
            self.source + "-generate-secrets",
            "sh",
            "-c",
            "cat > /run/secrets/.env.secrets",
            input=("AUTH_FIELD_ENCRYPTION_KEY=" + self.key + "\n").encode(),
        )

    def cleanup(self):
        for name in self.created:
            subprocess.run(
                ["docker", "rm", "-f", "-v", name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        for name in self.volumes:
            subprocess.run(
                ["docker", "volume", "rm", name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def test_complete_restore_to_clean_project(self):
        snapshot = recovery.backup(self.source, Path(self.temp.name))
        manifest = recovery.load_manifest(snapshot)
        self.assertEqual(len(manifest["mounts"]), 3)
        recovery.restore(self.target, snapshot, self.target)
        for name in self.created:
            if name.startswith(self.target):
                self.command("start", name)
        db = self.target + "-database"
        for _ in range(60):
            result = subprocess.run(
                ["docker", "exec", db, "pg_isready", "-U", "postgres"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if result.returncode == 0:
                break
            time.sleep(0.5)
        row = (
            self.command(
                "exec",
                db,
                "psql",
                "-U",
                "postgres",
                "-tAc",
                "SELECT text FROM recovery_fixture WHERE id=1",
            )
            .decode()
            .strip()
        )
        self.assertEqual(row, "restored memory")
        self.assertEqual(
            self.command(
                "exec",
                self.target + "-object-store",
                "cat",
                "/data/objects/attachment.bin",
            ),
            b"synthetic uploaded file\x00\x01",
        )
        self.assertEqual(
            self.command(
                "exec",
                self.target + "-generate-secrets",
                "cat",
                "/run/secrets/.env.secrets",
            ),
            ("AUTH_FIELD_ENCRYPTION_KEY=" + self.key + "\n").encode(),
        )
        for name in self.created:
            if name.startswith(self.source):
                self.assertEqual(
                    self.command(
                        "inspect", name, "--format", "{{.State.Running}}"
                    ).strip(),
                    b"true",
                )
