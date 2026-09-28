"""
Per-user HMT checkpoint paths + vocab fingerprinting.

Every HMT artifact (l0_mae, hmt_checkpoint, hmt_calibrated, ONNX FP32/INT8,
LoRA adapter, reports) lives in an isolated per-user directory:

    {models_dir}/hmt/users/{user_id}/

A single shared checkpoint cannot work: the L1 token embedding / head are sized
by the user's L1 vocabulary, which is per-user and grows as the labeler mints
clusters. Loading a checkpoint trained with one vocab into a model built for a
different vocab fails with a state_dict size mismatch. Per-user directories keep
each user's model matched to their own vocab, and the fingerprint below lets the
nightly job detect when a user's vocab has drifted away from their checkpoint and
trigger a re-bootstrap (see CI-Server-ad4).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path

from ci.hbpe.config import settings

ARCH_STAMP = "architecture.json"
ONNX_EXPORT_REPORT = "onnx_export_report.json"


def user_ckpt_dir(user_id: str, *, create: bool = False) -> Path:
    """Return the per-user HMT checkpoint directory.

    Pass create=True at write sites to ensure the directory exists; readers and
    existence checks should leave it False so they don't materialise empty dirs.
    """
    # user_id names a directory: it must be a UUID, so no caller-supplied value
    # can carry a path separator into models_dir.
    d = Path(settings.models_dir) / "hmt" / "users" / str(uuid.UUID(str(user_id)))
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def l1_vocab_fingerprint(l1_vocab) -> str:
    """Stable hash of an L1 vocab's ordered token list.

    Two checkpoints are interchangeable iff their L1 vocab fingerprints match
    (same cluster set, same index order). Used to detect the vocab drift that
    would otherwise make a saved checkpoint unloadable into a freshly-built
    model. Accepts any object exposing ``idx_to_token`` (i.e. ci.model.vocab.Vocab).
    """
    joined = "\n".join(l1_vocab.idx_to_token)
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()


# Artifact filenames live inside the per-user directory. Kept as constants so
# every reader/writer agrees on the names.
L0_MAE_CKPT = "l0_mae_checkpoint.pt"
HMT_CKPT = "hmt_checkpoint.pt"
HMT_CALIBRATED = "hmt_calibrated.pt"
HMT_FP32_ONNX = "hmt_fp32.onnx"
HMT_INT8_ONNX = "hmt_int8.onnx"
MODEL_ARTIFACTS = (HMT_INT8_ONNX, HMT_FP32_ONNX, HMT_CALIBRATED, HMT_CKPT)


def architecture_fingerprint() -> str:
    """Stable id of the compiled-in HMT shape.

    Stored beside checkpoints so a Hub image that grew the model (64-d → 256-d)
    refuses to keep serving the old weights and nightly/bootstrap retrains.
    """
    from ci.hbpe.model.transformer import D_FF, D_MODEL, N_HEADS, N_LAYERS

    return f"{D_MODEL}x{N_LAYERS}h{N_HEADS}ff{D_FF}"


def write_architecture_stamp(user_id: str) -> Path:
    """Write architecture.json next to this user's checkpoints."""
    from ci.hbpe.model.transformer import D_FF, D_MODEL, DROPOUT, N_HEADS, N_LAYERS

    d = user_ckpt_dir(user_id, create=True)
    path = d / ARCH_STAMP
    path.write_text(
        json.dumps(
            {
                "fingerprint": architecture_fingerprint(),
                "d_model": D_MODEL,
                "n_heads": N_HEADS,
                "n_layers": N_LAYERS,
                "d_ff": D_FF,
                "dropout": DROPOUT,
            },
            indent=2,
        )
    )
    return path


def architecture_matches(user_id: str) -> bool:
    """True when architecture.json exists and matches the running binary."""
    path = user_ckpt_dir(user_id) / ARCH_STAMP
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError, TypeError):
        return False
    return data.get("fingerprint") == architecture_fingerprint()


def int8_is_servable(user_id: str) -> bool:
    """True only when the last ONNX export proved INT8 within the accuracy delta.

    A failed INT8 graph (L0 acc collapsing ~30 pp) must not be preferred over
    FP32 just because the file exists on disk.
    """
    path = user_ckpt_dir(user_id) / ONNX_EXPORT_REPORT
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError, TypeError):
        return False
    return data.get("delta_passed") is True


def lora_adapter_path(user_id: str, *, create: bool = False) -> Path:
    """Per-user LoRA adapter path."""
    return user_ckpt_dir(user_id, create=create) / f"lora_{user_id}.pt"


def model_exists(user_id: str) -> bool:
    """True if any servable HMT artifact exists for the user."""
    d = user_ckpt_dir(user_id)
    return any((d / name).exists() for name in MODEL_ARTIFACTS)
