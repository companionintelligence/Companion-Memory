"""Tests for HBPE parallel batched trainer and headless runner."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import torch

from ci.hbpe.model.parallel_trainer import (
    TokenStreamFileDataset,
    collate_hmt_joint_batch,
    collate_l0_mae_batch,
    train_hmt_joint_parallel,
    train_l0_mae_parallel,
)
from ci.hbpe.model.train_runner import run_headless_job
from ci.hbpe.model.vocab import build_l0_vocab, build_l1_vocab


L0_SAMPLES = ["WORK", "EXERCISE", "SOCIAL", "ERRAND", "LEISURE", "TRANSIT", "SLEEP", "UNKNOWN"]


def _generate_synthetic_day(day_idx: int, n_tokens: int = 10) -> list[dict]:
    """Generate a valid synthetic day sequence with SOD, L0, L1, and EOD tokens."""
    tokens = [{"level": "SOD", "token_id": "SOD", "bucket_idx": 0}]
    for i in range(1, n_tokens - 1):
        if i % 3 == 0:
            tokens.append(
                {"level": "L1", "token_id": f"action_{i % 5}", "bucket_idx": min(47, i * 2)}
            )
        else:
            tokens.append(
                {"level": "L0", "token_id": L0_SAMPLES[i % len(L0_SAMPLES)], "bucket_idx": min(47, i * 2)}
            )
    tokens.append({"level": "EOD", "token_id": "EOD", "bucket_idx": 47})
    return tokens


def test_token_stream_file_dataset_in_memory_and_jsonl(tmp_path: Path):
    day1 = _generate_synthetic_day(1, n_tokens=8)
    day2 = _generate_synthetic_day(2, n_tokens=12)

    # In-memory
    ds_mem = TokenStreamFileDataset([day1, day2])
    assert len(ds_mem) == 2
    assert ds_mem[0] == day1
    assert ds_mem[1] == day2

    # JSONL file
    jsonl_path = tmp_path / "stream.jsonl"
    with jsonl_path.open("w", encoding="utf-8") as f:
        f.write(json.dumps(day1) + "\n")
        f.write(json.dumps(day2) + "\n")

    ds_file = TokenStreamFileDataset(jsonl_path)
    assert len(ds_file) == 2
    assert ds_file[0] == day1
    assert ds_file[1] == day2


def test_collate_l0_mae_batch():
    vocab = build_l0_vocab()
    day1 = _generate_synthetic_day(1, n_tokens=8)
    day2 = _generate_synthetic_day(2, n_tokens=14)

    batch = collate_l0_mae_batch([day1, day2], vocab)
    assert batch is not None
    t_ids, t_buckets, t_pad, t_targets, mask_positions = batch

    # Batch dimension is 2
    assert t_ids.shape[0] == 2
    assert t_buckets.shape[0] == 2
    assert t_pad.shape[0] == 2
    assert t_targets.shape[0] == 2

    # Sequence dimension padded to max length in batch
    assert t_ids.shape[1] >= 8
    assert len(mask_positions) == 2
    assert isinstance(mask_positions[0], set)


def test_collate_hmt_joint_batch():
    from ci.hbpe.model.vocab import _SPECIAL, _make_vocab
    l0_vocab = build_l0_vocab()
    l1_vocab = _make_vocab(_SPECIAL + ["action_0", "action_1", "action_2", "action_3", "action_4"])

    day1 = _generate_synthetic_day(1, n_tokens=10)
    day2 = _generate_synthetic_day(2, n_tokens=16)

    batch = collate_hmt_joint_batch([day1, day2], l0_vocab, l1_vocab)
    assert batch is not None
    t_ids, t_buckets, t_levels, t_pad, t_l0_targets, t_l1_targets = batch

    assert t_ids.shape[0] == 2
    assert t_levels.shape == t_ids.shape
    assert t_pad.shape == t_ids.shape
    assert t_l0_targets.shape == t_ids.shape
    assert t_l1_targets.shape == t_ids.shape


def test_parallel_train_l0_mae_and_hmt_joint(tmp_path: Path):
    uid = "test-user-parallel"
    days = [_generate_synthetic_day(i, n_tokens=12) for i in range(8)]
    train_ds = TokenStreamFileDataset(days[:6])
    val_ds = TokenStreamFileDataset(days[6:])

    progress_events = []

    def cb(event):
        progress_events.append(event)

    # 1. Pretrain L0 MAE for 2 epochs on CPU
    mae_ckpt = train_l0_mae_parallel(
        user_id=uid,
        train_dataset=train_ds,
        val_dataset=val_ds,
        batch_size=2,
        n_epochs=2,
        device="cpu",
        progress_cb=cb,
        checkpoint_dir=tmp_path,
    )
    assert mae_ckpt.exists()
    assert len(progress_events) == 2
    assert progress_events[-1].phase == "pretrain_l0_mae"

    # 2. Joint HMT fine-tuning for 2 epochs on CPU
    hmt_ckpt = train_hmt_joint_parallel(
        user_id=uid,
        train_dataset=train_ds,
        val_dataset=val_ds,
        batch_size=2,
        n_epochs=2,
        device="cpu",
        progress_cb=cb,
        checkpoint_dir=tmp_path,
    )
    assert hmt_ckpt.exists()
    assert progress_events[-1].phase == "train_hmt_joint"


def test_run_headless_job_runner(tmp_path: Path):
    uid = "headless-user"
    days = [_generate_synthetic_day(i, n_tokens=10) for i in range(6)]

    dataset_path = tmp_path / "dataset.jsonl"
    with dataset_path.open("w", encoding="utf-8") as f:
        for d in days:
            f.write(json.dumps(d) + "\n")

    manifest = {
        "jobId": "job-test-123",
        "userId": uid,
        "appId": "ci-memory",
        "jobType": "hbpe_bootstrap_hmt",
        "hyperparameters": {
            "batchSize": 2,
            "epochs": 2,
        },
        "resourcePolicy": {
            "devicePreference": "cpu",
        },
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    out_dir = tmp_path / "artifacts"
    summary = run_headless_job(manifest_path, dataset_path, out_dir)

    assert summary["status"] == "COMPLETED"
    assert summary["jobId"] == "job-test-123"
    assert Path(summary["artifacts"]["maeCheckpoint"]).exists()
    assert Path(summary["artifacts"]["hmtCheckpoint"]).exists()
