"""
HBPE Headless Training Runner CLI.

Invoked by Companion Hub Training Engine (locally or on a Hub Pool worker node):
  python -m ci.hbpe.model.train_runner --manifest /path/to/manifest.json --dataset /path/to/data.jsonl --output /path/to/artifacts
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from pathlib import Path

from ci.hbpe.model.parallel_trainer import (
    DEFAULT_LR,
    DEFAULT_LR_FINETUNE,
    TokenStreamFileDataset,
    TrainingProgress,
    train_hmt_joint_parallel,
    train_l0_mae_parallel,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("hbpe-train-runner")


def sse_event_emitter(progress: TrainingProgress) -> None:
    """Emit JSON lines to stdout for Companion Hub SSE parser."""
    event = {
        "type": "PROGRESS",
        "phase": progress.phase,
        "epoch": progress.epoch,
        "totalEpochs": progress.n_epochs,
        "trainLoss": round(progress.train_loss, 4),
        "valLoss": round(progress.val_loss, 4) if progress.val_loss is not None else None,
        "learningRate": progress.learning_rate,
        "elapsedSeconds": round(progress.elapsed_seconds, 1),
        "etaSeconds": round(progress.eta_seconds, 1),
        "device": progress.device,
    }
    sys.stdout.write(f"CI_TRAIN_EVENT: {json.dumps(event)}\n")
    sys.stdout.flush()


def run_headless_job(manifest_path: Path, dataset_path: Path, output_dir: Path) -> dict:
    log.info("Loading manifest from %s", manifest_path)
    with manifest_path.open("r", encoding="utf-8") as f:
        manifest = json.load(f)

    raw_uid = manifest.get("userId")
    try:
        user_id = str(uuid.UUID(raw_uid)) if raw_uid else "00000000-0000-0000-0000-000000000000"
    except (ValueError, TypeError):
        user_id = "00000000-0000-0000-0000-000000000000"

    hyperparams = manifest.get("hyperparameters", {})
    batch_size = hyperparams.get("batchSize", 16)
    epochs = hyperparams.get("epochs", 50)
    learning_rate = hyperparams.get("learningRate", DEFAULT_LR)
    device = manifest.get("resourcePolicy", {}).get("devicePreference", "auto")
    if device == "auto":
        device = None

    output_dir.mkdir(parents=True, exist_ok=True)

    log.info("Loading decoupled dataset from %s", dataset_path)
    full_ds = TokenStreamFileDataset(dataset_path)
    n_total = len(full_ds)
    if n_total < 4:
        raise ValueError(f"Dataset too small ({n_total} days). Need at least 4.")

    val_fraction = manifest.get("dataset", {}).get("valFraction", 0.15)
    val_count = max(1, int(n_total * val_fraction))
    train_count = n_total - val_count

    train_data = [full_ds[i] for i in range(train_count)]
    val_data = [full_ds[i] for i in range(train_count, n_total)]

    train_ds = TokenStreamFileDataset(train_data)
    val_ds = TokenStreamFileDataset(val_data)

    log.info("Split dataset: train=%d days, val=%d days", len(train_ds), len(val_ds))

    # Phase 1: L0 MAE Pre-training
    mae_ckpt = train_l0_mae_parallel(
        user_id=user_id,
        train_dataset=train_ds,
        val_dataset=val_ds,
        batch_size=batch_size,
        n_epochs=epochs,
        lr=learning_rate,
        device=device,
        progress_cb=sse_event_emitter,
        checkpoint_dir=output_dir,
    )

    # Phase 2: HMT Joint Fine-tuning
    hmt_ckpt = train_hmt_joint_parallel(
        user_id=user_id,
        train_dataset=train_ds,
        val_dataset=val_ds,
        batch_size=batch_size,
        n_epochs=epochs,
        lr=learning_rate,
        device=device,
        progress_cb=sse_event_emitter,
        checkpoint_dir=output_dir,
    )

    summary = {
        "status": "COMPLETED",
        "jobId": manifest.get("jobId", "unknown"),
        "artifacts": {
            "maeCheckpoint": str(mae_ckpt),
            "hmtCheckpoint": str(hmt_ckpt),
        },
    }
    sys.stdout.write(f"CI_TRAIN_COMPLETE: {json.dumps(summary)}\n")
    sys.stdout.flush()
    return summary


def main():
    parser = argparse.ArgumentParser(description="HBPE Headless Training Runner")
    parser.add_argument("--manifest", type=Path, required=True, help="Path to TrainingJobManifest JSON")
    parser.add_argument("--dataset", type=Path, required=True, help="Path to serialized token stream JSONL")
    parser.add_argument("--output", type=Path, required=True, help="Output directory for model checkpoints")
    args = parser.parse_args()

    run_headless_job(args.manifest, args.dataset, args.output)


if __name__ == "__main__":
    main()
