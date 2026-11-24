import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "recovery", Path(__file__).parents[1] / "appliance-recovery.py"
)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


def container(name, *, running=True, mounts=None):
    return {
        "Id": name,
        "Image": "sha256:fixture",
        "Config": {
            "Image": "fixture:1",
            "Labels": {"com.docker.compose.service": name},
        },
        "State": {"Running": running},
        "Mounts": mounts or [],
    }


def mount(name, destination, *, rw=True, kind="volume"):
    return {
        "Type": kind,
        "Name": name,
        "Source": name if kind == "volume" else "/host/" + name,
        "Destination": destination,
        "RW": rw,
    }


def archive(path, name="./fixture", data=b"original", *, link=None):
    with tarfile.open(path, "w:gz") as handle:
        info = tarfile.TarInfo(name)
        if link:
            info.type = tarfile.SYMTYPE
            info.linkname = link
            handle.addfile(info)
        else:
            info.size = len(data)
            handle.addfile(info, io.BytesIO(data))


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.items = [
            container("api"),
            container("database", mounts=[mount("db", "/var/lib/postgresql")]),
            container("object-store", mounts=[mount("objects", "/data/objects")]),
            container(
                "generate-secrets",
                running=False,
                mounts=[mount("secrets", "/run/secrets")],
            ),
        ]
        inventory = patch.object(recovery, "all_containers", return_value=self.items)
        self.inventory = inventory.start()
        self.addCleanup(inventory.stop)

    def capture(self, entry, path):
        if entry["service"] == "generate-secrets":
            archive(path, "./.env.secrets", b"AUTH_FIELD_ENCRYPTION_KEY=fixture\n")
        else:
            archive(path)

    def make_snapshot(self, **kwargs):
        with (
            patch.object(recovery, "containers", return_value=self.items),
            patch.object(recovery, "docker"),
            patch.object(recovery, "capture", side_effect=self.capture),
        ):
            return recovery.backup("fixture", self.root, **kwargs)

    def test_shared_store_is_refused_before_stopping_or_capturing(self):
        outsider = container(
            "other-project", mounts=[mount("db", "/var/lib/postgresql")]
        )
        self.inventory.return_value = [*self.items, outsider]
        with (
            patch.object(recovery, "containers", return_value=self.items),
            patch.object(recovery, "docker") as docker,
            patch.object(recovery, "capture") as capture,
        ):
            with self.assertRaisesRegex(ValueError, "shared with another project"):
                recovery.backup("fixture", self.root)
        docker.assert_not_called()
        capture.assert_not_called()
        self.assertEqual(list(self.root.glob("*.partial")), [])
        self.assertEqual(
            json.loads((self.root / "fixture.status.json").read_text())["state"],
            "failed",
        )

    def test_destination_inside_captured_bind_store_is_refused_before_stop(self):
        self.items[2]["Mounts"] = [
            {
                **mount("objects", "/data/objects", kind="bind"),
                "Source": str(self.root),
            }
        ]
        nested = self.root / "nested-backups"
        nested.mkdir()
        with (
            patch.object(recovery, "containers", return_value=self.items),
            patch.object(recovery, "docker") as docker,
            patch.object(recovery, "capture") as capture,
        ):
            with self.assertRaisesRegex(ValueError, "inside a captured data store"):
                recovery.backup("fixture", nested)
        docker.assert_not_called()
        capture.assert_not_called()
        self.assertEqual(list(nested.glob("*.partial")), [])

    def test_dedicated_status_directory_has_sanitized_atomic_updates(self):
        with tempfile.TemporaryDirectory() as outside:
            status_dir = Path(outside) / "status"
            snapshot = self.make_snapshot(status_directory=status_dir)
            public_file = status_dir / "fixture.status.json"
            # An open directory follows each replacement, unlike a bind mount
            # of the original JSON inode. Docker exercises this in the real drill.
            directory = os.open(status_dir, os.O_RDONLY)
            self.addCleanup(os.close, directory)
            with os.fdopen(
                os.open(public_file.name, os.O_RDONLY, dir_fd=directory)
            ) as handle:
                first = json.load(handle)
            inode = public_file.stat().st_ino
            self.assertEqual(first["state"], "complete")
            self.assertNotIn("snapshot", first)
            self.assertNotIn(str(snapshot), json.dumps(first))
            self.assertEqual(public_file.stat().st_mode & 0o777, 0o644)
            recovery.write_status(
                self.root,
                "fixture",
                {
                    **first,
                    "state": "failed",
                    "error": "private /secret/path",
                    "snapshot": str(snapshot),
                },
                status_dir,
            )
            self.assertNotEqual(public_file.stat().st_ino, inode)
            with os.fdopen(
                os.open(public_file.name, os.O_RDONLY, dir_fd=directory)
            ) as handle:
                second = json.load(handle)
            self.assertEqual(second["state"], "failed")
            self.assertNotIn("error", second)
            self.assertNotIn("snapshot", second)
            self.assertEqual(set(second) - recovery.PUBLIC_STATUS_KEYS, set())
            self.assertIn(
                "private /secret/path", (self.root / public_file.name).read_text()
            )

    def test_status_directory_cannot_expose_snapshots_or_unrelated_files(self):
        for status in [self.root, self.root.parent, self.root / "status"]:
            with (
                self.subTest(path=status),
                self.assertRaisesRegex(ValueError, "dedicated status"),
            ):
                recovery.prepare_status_directory(status, self.root)
        with tempfile.TemporaryDirectory() as outside:
            status_dir = Path(outside)
            (status_dir / "private.env").write_text("SECRET=private")
            with self.assertRaisesRegex(ValueError, "only sanitized"):
                recovery.prepare_status_directory(status_dir, self.root)

    def test_backup_includes_objects_database_encryption_root_and_status(self):
        snapshot = self.make_snapshot()
        manifest = recovery.load_manifest(snapshot)
        self.assertEqual(
            {m["service"] for m in manifest["mounts"]},
            {"database", "object-store", "generate-secrets"},
        )
        self.assertTrue(manifest["encryption_root_included"])
        status = json.loads((self.root / "fixture.status.json").read_text())
        self.assertEqual(status["state"], "complete")
        self.assertEqual(status["snapshot"], snapshot.name)
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o700)

    def test_stops_database_last_and_restarts_only_original_running_containers(self):
        events = []
        with patch.object(
            recovery, "docker", side_effect=lambda *a, **kw: events.append(a)
        ):
            with recovery.stopped(self.items):
                events.append(("capture",))
        stops = [e[3] for e in events if e[0] == "stop"]
        starts = [e[1] for e in events if e[0] == "start"]
        self.assertEqual(stops[-1], "database")
        self.assertEqual(starts[0], "database")
        self.assertNotIn("generate-secrets", starts)
        self.assertEqual(set(starts), set(stops))

    def test_backup_failure_resumes_original_stack_and_never_publishes_partial(self):
        calls = []
        with (
            patch.object(recovery, "containers", return_value=self.items),
            patch.object(
                recovery, "docker", side_effect=lambda *a, **kw: calls.append(a)
            ),
            patch.object(recovery, "capture", side_effect=RuntimeError("disk full")),
        ):
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                recovery.backup("fixture", self.root)
        self.assertTrue(any(c[0] == "start" for c in calls))
        self.assertEqual(list(self.root.glob("*.partial")), [])
        self.assertEqual(
            json.loads((self.root / "fixture.status.json").read_text())["state"],
            "failed",
        )

    def test_restore_failure_leaves_target_stopped_and_preserves_exception(self):
        events = []
        with patch.object(
            recovery, "docker", side_effect=lambda *a, **kw: events.append(a)
        ):
            with self.assertRaisesRegex(RuntimeError, "restore failed"):
                with recovery.stopped(self.items, restart_on_failure=False):
                    raise RuntimeError("restore failed")
        self.assertFalse(any(e[0] == "start" for e in events))

    def test_no_master_key_cannot_be_marked_complete(self):
        def capture_without_key(entry, path):
            archive(path)

        with (
            patch.object(recovery, "containers", return_value=self.items),
            patch.object(recovery, "docker"),
            patch.object(recovery, "capture", side_effect=capture_without_key),
        ):
            with self.assertRaisesRegex(ValueError, "No master encryption key"):
                recovery.backup("fixture", self.root)
        self.assertFalse(
            any(p.name.startswith("fixture-") for p in self.root.iterdir())
        )

    def test_explicit_environment_key_is_included_and_verified(self):
        secrets = self.root / "source.env"
        secrets.write_text("AUTH_FIELD_ENCRYPTION_KEY=fixture\n")
        with (
            patch.object(recovery, "containers", return_value=self.items[:3]),
            patch.object(recovery, "docker"),
            patch.object(recovery, "capture", side_effect=self.capture),
        ):
            snapshot = recovery.backup("fixture", self.root, secrets)
        self.assertIn("deployment_env", recovery.load_manifest(snapshot))
        (snapshot / "deployment.env").write_text("modified")
        with self.assertRaisesRegex(ValueError, "environment file failed"):
            recovery.load_manifest(snapshot)

    def test_modified_archive_is_rejected_before_any_target_operation(self):
        snapshot = self.make_snapshot()
        first = json.loads((snapshot / "manifest.json").read_text())["mounts"][0][
            "archive"
        ]
        (snapshot / first).write_bytes(b"tampered")
        with patch.object(recovery, "containers") as target:
            with self.assertRaisesRegex(ValueError, "checksum"):
                recovery.restore("target", snapshot, "target")
            target.assert_not_called()

    def test_archive_traversal_and_external_links_are_rejected(self):
        for name, link in [
            ("../escape", None),
            ("/escape", None),
            ("safe", "../../escape"),
            ("safe", "/etc/passwd"),
        ]:
            with self.subTest(name=name, link=link):
                path = self.root / "bad.tar.gz"
                archive(path, name, link=link)
                with self.assertRaises(ValueError):
                    recovery.validate_tar(path)

    def test_corrupt_gzip_trailer_is_rejected(self):
        path = self.root / "bad.tar.gz"
        archive(path)
        data = bytearray(path.read_bytes())
        data[-8] ^= 255
        path.write_bytes(data)
        with self.assertRaises((OSError, EOFError, tarfile.TarError)):
            recovery.validate_tar(path)

    def test_sources_and_readonly_original_exports_are_excluded(self):
        self.items[0]["Mounts"] = [
            mount("code", "/app", kind="bind"),
            mount("exports", "/repo", kind="bind", rw=False),
            mount("imports", "/var/lib/ci-import", kind="bind"),
        ]
        sources = [m["mount"]["Source"] for m in recovery.data_mounts(self.items)]
        self.assertNotIn("/host/code", sources)
        self.assertNotIn("/host/exports", sources)
        self.assertIn("/host/imports", sources)

    def test_shared_volume_is_captured_once_using_writable_generator(self):
        self.items[0]["Mounts"] = [mount("secrets", "/run/secrets", rw=False)]
        found = [
            m
            for m in recovery.data_mounts(self.items)
            if m["mount"]["Name"] == "secrets"
        ]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["service"], "generate-secrets")

    def test_shared_writable_mount_keeps_its_service_in_any_listing_order(self):
        shared = mount("imports", "/var/lib/ci-import")
        api = container("api", mounts=[shared])
        worker = container("worker", mounts=[shared])

        def recorded(items):
            return {
                (m["service"], m["destination"])
                for m in recovery.data_mounts(items)
                if m["mount"]["Name"] == "imports"
            }

        expected = {("api", "/var/lib/ci-import")}
        self.assertEqual(recorded([*self.items, api, worker]), expected)
        self.assertEqual(recorded([*self.items, worker, api]), expected)

    def test_destination_refuses_the_home_directory_reached_through_a_symlink(self):
        real = self.root / "real-home"
        real.mkdir()
        alias = self.root / "home-alias"
        alias.symlink_to(real)
        with patch.dict(os.environ, {"HOME": str(alias)}):
            with self.assertRaisesRegex(ValueError, "dedicated backup directory"):
                recovery.destination(str(real))

    def test_missing_object_store_refuses_incomplete_backup(self):
        with self.assertRaisesRegex(ValueError, "object-store"):
            recovery.data_mounts(self.items[:2])

    def test_restore_requires_exact_target_confirmation(self):
        with patch.object(recovery, "containers") as target:
            with self.assertRaisesRegex(ValueError, "confirm-project"):
                recovery.restore("target", self.root, "another")
            target.assert_not_called()

    def test_prune_only_removes_own_verified_format_directories(self):
        for name, project in [
            ("fixture-1", "fixture"),
            ("fixture-2", "fixture"),
            ("fixture-other", "another"),
        ]:
            path = self.root / name
            path.mkdir()
            (path / "manifest.json").write_text(
                json.dumps({"schema": 1, "project": project})
            )
        unrelated = self.root / "fixture-unrelated"
        unrelated.mkdir()
        recovery.prune(self.root, "fixture", 1)
        self.assertFalse((self.root / "fixture-1").exists())
        self.assertTrue((self.root / "fixture-2").exists())
        self.assertTrue((self.root / "fixture-other").exists())
        self.assertTrue(unrelated.exists())

    def test_update_selects_explicit_compose_configuration_only(self):
        self.assertEqual(
            recovery.update_options(
                [
                    "--",
                    "-f",
                    "compose.yml",
                    "--profile=production",
                    "--env-file",
                    "deployment.env",
                ]
            ),
            [
                "-f",
                "compose.yml",
                "--profile",
                "production",
                "--env-file",
                "deployment.env",
            ],
        )
        for values in [
            [],
            ["--profile", "production"],
            ["-f"],
            ["-f", "--profile"],
            ["-f", "compose.yml", "down"],
            ["--project-name=another", "-f", "compose.yml"],
        ]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                recovery.update_options(values)


if __name__ == "__main__":
    unittest.main()
