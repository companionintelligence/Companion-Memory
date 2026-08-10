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
from pathlib import Path

from ci.hbpe.config import settings


def user_ckpt_dir(user_id: str, *, create: bool = False) -> Path:
    """Return the per-user HMT checkpoint directory.

    Pass create=True at write sites to ensure the directory exists; readers and
    existence checks should leave it False so they don't materialise empty dirs.
    """
    d = Path(settings.models_dir) / "hmt" / "users" / str(user_id)
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


def lora_adapter_path(user_id: str, *, create: bool = False) -> Path:
    """Per-user LoRA adapter path."""
    return user_ckpt_dir(user_id, create=create) / f"lora_{user_id}.pt"


def model_exists(user_id: str) -> bool:
    """True if any servable HMT artifact exists for the user."""
    d = user_ckpt_dir(user_id)
    return any((d / name).exists() for name in MODEL_ARTIFACTS)


def model_bucket_width(user_id: str) -> int | None:
    """Return the position-embedding width baked into the user's checkpoint, if known."""
    import torch

    d = user_ckpt_dir(user_id)
    for name in (HMT_CALIBRATED, HMT_CKPT, L0_MAE_CKPT):
        path = d / name
        if not path.exists():
            continue
        try:
            ckpt = torch.load(path, map_location="cpu", weights_only=True)
        except Exception:
            continue
        state = ckpt.get("model_state", ckpt)
        weight = state.get("pos_emb.weight")
        if weight is not None:
            return int(weight.shape[0])

    for onnx_name in (HMT_INT8_ONNX, HMT_FP32_ONNX):
        path = d / onnx_name
        if not path.exists():
            continue
        try:
            import onnxruntime as ort

            sess = ort.InferenceSession(str(path))
            for inp in sess.get_inputs():
                if inp.name == "bucket_idxs" and inp.shape and len(inp.shape) >= 2:
                    dim = inp.shape[1]
                    if isinstance(dim, int):
                        return dim
        except Exception:
            continue
    return None
