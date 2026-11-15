"""Contracts for ci.hbpe.model.train_io. Runs without torch."""

from __future__ import annotations

import random

import pytest

from ci.hbpe.model import train_io as t


def test_atomic_write_replaces_and_leaves_no_temp(tmp_path):
    dest = tmp_path / "ckpt.pt"
    dest.write_bytes(b"old")
    t.atomic_write(dest, lambda tmp: tmp.write_bytes(b"new"))
    assert dest.read_bytes() == b"new"
    assert [p.name for p in tmp_path.iterdir()] == ["ckpt.pt"]


def test_atomic_write_failure_keeps_original(tmp_path):
    dest = tmp_path / "ckpt.pt"
    dest.write_bytes(b"good")

    def boom(tmp):
        tmp.write_bytes(b"half")
        raise RuntimeError("crash mid-write")

    with pytest.raises(RuntimeError):
        t.atomic_write(dest, boom)
    assert dest.read_bytes() == b"good"
    assert [p.name for p in tmp_path.iterdir()] == ["ckpt.pt"]


def test_atomic_write_creates_parent_dirs(tmp_path):
    dest = tmp_path / "a" / "b" / "x.txt"
    t.atomic_write_text(dest, "hi")
    assert dest.read_text() == "hi"


def test_archive_previous_noop_when_missing(tmp_path):
    assert t.archive_previous(tmp_path / "lora.pt") is None


def test_archive_keeps_newest_versions_only(tmp_path):
    dest = tmp_path / "lora.pt"
    for n in range(1, 6):
        dest.write_bytes(f"v{n}".encode())
        t.archive_previous(dest, keep=3)
    versions = t.list_versions(dest)
    assert [p.read_bytes() for p in versions] == [b"v3", b"v4", b"v5"]


def test_restore_previous_rolls_back(tmp_path):
    dest = tmp_path / "lora.pt"
    dest.write_bytes(b"good")
    t.archive_previous(dest)
    dest.write_bytes(b"bad")
    t.restore_previous(dest)
    assert dest.read_bytes() == b"good"


def test_restore_previous_none_without_history(tmp_path):
    assert t.restore_previous(tmp_path / "lora.pt") is None


def test_versions_do_not_match_other_files(tmp_path):
    (tmp_path / "lora_a.pt").write_bytes(b"a")
    (tmp_path / "lora_ab.pt").write_bytes(b"ab")
    t.archive_previous(tmp_path / "lora_a.pt")
    assert len(t.list_versions(tmp_path / "lora_a.pt")) == 1
    assert t.list_versions(tmp_path / "lora_ab.pt") == []


def test_meta_mismatch_raises():
    saved = t.adapter_meta(
        architecture="256x6h8ff1024", l1_vocab_fingerprint="aa", base_digest="d1"
    )
    with pytest.raises(t.AdapterMismatch):
        t.check_adapter_meta(saved, base_digest="d2")
    with pytest.raises(t.AdapterMismatch):
        t.check_adapter_meta(saved, architecture="64x2h4ff256")


def test_meta_match_and_missing_fields_pass():
    saved = t.adapter_meta(
        architecture="256x6h8ff1024", l1_vocab_fingerprint=None, base_digest="d1"
    )
    t.check_adapter_meta(saved, architecture="256x6h8ff1024", base_digest="d1")
    t.check_adapter_meta(saved, l1_vocab_fingerprint="anything")
    t.check_adapter_meta(None, base_digest="d9")
    t.check_adapter_meta({}, base_digest="d9")


def test_file_digest(tmp_path):
    f = tmp_path / "base.pt"
    assert t.file_digest(f) is None
    f.write_bytes(b"abc")
    d1 = t.file_digest(f)
    f.write_bytes(b"abd")
    assert d1 != t.file_digest(f)
    assert len(d1) == 16


def test_mean_step_loss_divides_by_steps_not_tokens():
    # Two steps, each already a per-token mean of 2.0, over 5,000 tokens.
    assert t.mean_step_loss(4.0, 2) == 2.0
    # The old formula gave 4.0 / 5000.
    assert t.mean_step_loss(4.0, 2) != 4.0 / 5000
    assert t.mean_step_loss(0.0, 0) is None


def test_monitor_loss_falls_back_to_train_when_no_val():
    assert t.select_monitor_loss(1.5, 0.0, 0) == (1.5, "train")
    assert t.select_monitor_loss(1.5, 0.9, 12) == (0.9, "val")


def test_seed_everything_is_repeatable():
    t.seed_everything(42)
    a = [random.random() for _ in range(3)]
    t.seed_everything(42)
    b = [random.random() for _ in range(3)]
    assert a == b


def test_seed_from_env(monkeypatch):
    monkeypatch.setenv("HBPE_TRAIN_SEED", "7")
    assert t.seed_everything() == 7


def test_is_finite():
    assert t.is_finite(1.0)
    assert not t.is_finite(None)
    assert not t.is_finite(float("nan"))
    assert not t.is_finite(float("inf"))
