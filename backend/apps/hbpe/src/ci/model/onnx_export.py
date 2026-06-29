"""
ONNX export + INT8 static quantization for HMTModel.

Steps (CI-HBPE-SPEC-001 §T4.1):
  1. Load hmt_calibrated.pt; merge LoRA adapter if present.
  2. Wrap model in an ONNX-safe forward (arithmetic blend instead of
     boolean mask indexing) to avoid tracing issues.
  3. torch.onnx.export → hmt_fp32.onnx  (opset 17, dynamic sequence axis).
  4. Run INT8 static quantization calibrated on the val set.
  5. Verify accuracy delta between fp32 and int8 < 1 pp on L0 top-1.
  6. Write onnx_export_report.json.

Outputs: hmt_fp32.onnx, hmt_int8.onnx, onnx_export_report.json
Implements T4.1 (CI-Server-0ue).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn

from ci.config import settings
from ci.model.calibration import _build_full_batch
from ci.model.checkpoints import user_ckpt_dir, HMT_FP32_ONNX, HMT_INT8_ONNX
from ci.model.dataset import TokenStreamDataset
from ci.model.evaluator import _load_calibrated
from ci.model.lora import load_adapter, merge_adapter
from ci.model.transformer import HMTModel
from ci.model.vocab import PAD_IDX, SOD_IDX, EOD_IDX, Vocab, build_l0_vocab, build_l1_vocab

log = logging.getLogger(__name__)

OPSET          = 17
DELTA_LIMIT    = 0.01   # 1 percentage-point max L0 top-1 delta
ONNX_SEQ_LEN   = 256    # Static length; runtime inputs are padded to this width
_SPECIAL_IDX   = {PAD_IDX, SOD_IDX, EOD_IDX}


# ── ONNX-safe wrapper ──────────────────────────────────────────────────────────

class _HMTONNXWrapper(nn.Module):
    """
    ONNX-friendly view of HMTModel.

    Replaces the per-level boolean mask assignment in HMTModel.forward
    with an arithmetic blend, which traces cleanly to ONNX Gather + Mul ops.
    Clamping prevents out-of-bounds embedding lookups for the wrong level's
    tokens (those positions are zeroed out by the blend anyway).
    """

    def __init__(self, model: HMTModel, l0_vocab_size: int, l1_vocab_size: int) -> None:
        super().__init__()
        self.l0_token_emb  = model.l0_token_emb
        self.l1_token_emb  = model.l1_token_emb
        self.pos_emb       = model.pos_emb
        self.level_emb     = model.level_emb
        self.encoder       = model.encoder
        self.l0_head       = model.l0_head
        self.l1_head       = model.l1_head
        self._l0_vsize     = l0_vocab_size
        self._l1_vsize     = l1_vocab_size

    def forward(
        self,
        token_ids:    torch.Tensor,   # (B, T) int64
        bucket_idxs:  torch.Tensor,   # (B, T) int64
        level_ids:    torch.Tensor,   # (B, T) int64  0=L0 1=L1
        padding_mask: torch.Tensor,   # (B, T) bool
    ) -> tuple[torch.Tensor, torch.Tensor]:
        l0_ids = token_ids.clamp(0, self._l0_vsize - 1)
        l1_ids = token_ids.clamp(0, self._l1_vsize - 1)

        l0_emb = self.l0_token_emb(l0_ids)               # (B, T, D)
        l1_emb = self.l1_token_emb(l1_ids)               # (B, T, D)

        # 0 → l0_emb, 1 → l1_emb
        w = level_ids.unsqueeze(-1).float()               # (B, T, 1)
        tok_emb = l0_emb * (1.0 - w) + l1_emb * w       # (B, T, D)

        x = tok_emb + self.pos_emb(bucket_idxs) + self.level_emb(level_ids)
        x = self.encoder(x, src_key_padding_mask=padding_mask)
        return self.l0_head(x), self.l1_head(x)


# ── Calibration data reader ────────────────────────────────────────────────────

class _CalibrationReader:
    """Minimal CalibrationDataReader for onnxruntime quantize_static."""

    def __init__(self, inputs: list[dict[str, np.ndarray]]) -> None:
        self._inputs = inputs
        self._idx    = 0

    def get_next(self) -> Optional[dict[str, np.ndarray]]:
        if self._idx >= len(self._inputs):
            return None
        item = self._inputs[self._idx]
        self._idx += 1
        return item

    def rewind(self) -> None:
        self._idx = 0


def _build_ort_inputs(
    dataset:      TokenStreamDataset,
    l0_vocab:     Vocab,
    l1_vocab:     Vocab,
    l0_vsize:     int,
    l1_vsize:     int,
) -> list[dict[str, np.ndarray]]:
    """Convert a TokenStreamDataset into a list of numpy input dicts for ORT."""
    inputs = []
    for day_tokens in dataset:
        batch = _build_full_batch(day_tokens, l0_vocab, l1_vocab, "cpu")
        if batch is None:
            continue
        token_ids, bucket_idxs, level_ids, padding_mask, _, _ = batch
        inputs.append(_make_ort_input(token_ids, bucket_idxs, level_ids, padding_mask))
    return inputs


def _make_ort_input(
    token_ids: torch.Tensor,
    bucket_idxs: torch.Tensor,
    level_ids: torch.Tensor,
    padding_mask: torch.Tensor,
) -> dict[str, np.ndarray]:
    """
    Build a static-shape ORT input dict.

    PyTorch's ONNX export for MultiheadAttention traces internal reshape sizes from
    the example input, so we export a fixed-width graph and pad all runtime inputs
    to the same sequence length.
    """
    seq_len = int(token_ids.shape[1])
    if seq_len > ONNX_SEQ_LEN:
        raise ValueError(
            f"Sequence length {seq_len} exceeds ONNX export width {ONNX_SEQ_LEN}. "
            "Increase ONNX_SEQ_LEN and re-export."
        )

    pad = ONNX_SEQ_LEN - seq_len
    tok_np = token_ids.numpy().astype(np.int64)
    bkt_np = bucket_idxs.numpy().astype(np.int64)
    lvl_np = level_ids.numpy().astype(np.int64)
    mask_np = padding_mask.numpy().astype(bool)

    if pad > 0:
        tok_np = np.pad(tok_np, ((0, 0), (0, pad)), constant_values=PAD_IDX)
        bkt_np = np.pad(bkt_np, ((0, 0), (0, pad)), constant_values=0)
        lvl_np = np.pad(lvl_np, ((0, 0), (0, pad)), constant_values=0)
        mask_np = np.pad(mask_np, ((0, 0), (0, pad)), constant_values=True)

    return {
        # Pass unclamped token_ids — the ONNX wrapper clamps per-level internally.
        "token_ids": tok_np,
        "bucket_idxs": bkt_np,
        "level_ids": lvl_np,
        "padding_mask": mask_np,
    }


# ── Accuracy helpers ───────────────────────────────────────────────────────────

def _ort_l0_top1(
    sess,
    ort_inputs: list[dict[str, np.ndarray]],
    dataset:    TokenStreamDataset,
    l0_vocab:   Vocab,
    l1_vocab:   Vocab,
) -> float:
    """Run all val/test days through an ORT session; return L0 top-1 accuracy."""
    correct = total = 0
    for inp, day_tokens in zip(ort_inputs, dataset):
        batch = _build_full_batch(day_tokens, l0_vocab, l1_vocab, "cpu")
        if batch is None:
            continue
        _, _, level_ids, _, l0_targets, _ = batch
        l0_logits_np = sess.run(["l0_logits"], inp)[0]   # (1, T, V_l0)
        l0_pos = np.where(level_ids[0].numpy() == 0)[0]
        for i in l0_pos:
            true_idx = int(l0_targets[0, i])
            if true_idx in _SPECIAL_IDX:
                continue
            pred = int(np.argmax(l0_logits_np[0, i]))
            correct += int(pred == true_idx)
            total   += 1
    return correct / max(total, 1)


# ── Main entry point ───────────────────────────────────────────────────────────

def export_and_quantize(
    user_id: str,
    val_ds:  TokenStreamDataset,
    test_ds: TokenStreamDataset,
    device:  Optional[str] = None,
) -> dict:
    """
    Export HMTModel to ONNX and produce an INT8-quantised version.

    Returns a report dict; writes hmt_fp32.onnx, hmt_int8.onnx,
    and onnx_export_report.json to {models_dir}/hmt/.
    """
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_static, QuantType

    ckpt_dir = user_ckpt_dir(user_id, create=True)
    fp32_path = ckpt_dir / HMT_FP32_ONNX
    int8_path = ckpt_dir / HMT_INT8_ONNX

    l0_vocab = build_l0_vocab()
    l1_vocab = build_l1_vocab(user_id)

    # ── 1. Load backbone and merge LoRA if present ─────────────────────────────
    model, _temp = _load_calibrated(user_id, l0_vocab, l1_vocab, "cpu")
    adapter_path = ckpt_dir / f"lora_{user_id}.pt"
    if adapter_path.exists():
        load_adapter(model, adapter_path)
        merge_adapter(model)
        log.info("Merged LoRA adapter into backbone for export")

    model.eval()
    l0_vsize = len(l0_vocab)
    l1_vsize = len(l1_vocab)

    # ── 2. Wrap in ONNX-safe forward ──────────────────────────────────────────
    wrapper = _HMTONNXWrapper(model, l0_vsize, l1_vsize)
    wrapper.eval()

    # Build a representative fixed-width example input for tracing.
    ex_tokens  = torch.full((1, ONNX_SEQ_LEN), PAD_IDX, dtype=torch.long)
    ex_buckets = torch.zeros((1, ONNX_SEQ_LEN), dtype=torch.long)
    ex_levels  = torch.zeros((1, ONNX_SEQ_LEN), dtype=torch.long)
    ex_mask    = torch.ones((1, ONNX_SEQ_LEN), dtype=torch.bool)

    # Non-padded prefix: SOD, WORK, WORK, EOD
    ex_tokens[0, :4] = torch.tensor([SOD_IDX, 4, 4, EOD_IDX], dtype=torch.long)
    ex_buckets[0, :4] = torch.tensor([0, 4, 8, 47], dtype=torch.long)
    ex_mask[0, :4] = False

    # ── 3. FP32 ONNX export ───────────────────────────────────────────────────
    log.info("Exporting fp32 ONNX → %s", fp32_path)
    torch.onnx.export(
        wrapper,
        (ex_tokens, ex_buckets, ex_levels, ex_mask),
        str(fp32_path),
        input_names  = ["token_ids", "bucket_idxs", "level_ids", "padding_mask"],
        output_names = ["l0_logits", "l1_logits"],
        opset_version    = OPSET,
        do_constant_folding = True,
    )
    fp32_size_mb = fp32_path.stat().st_size / 1_048_576
    log.info("FP32 ONNX size: %.2f MB", fp32_size_mb)

    # ── 4. Build calibration data and INT8 quantise ────────────────────────────
    log.info("Building calibration data from val set (%d days)", len(val_ds))
    cal_inputs = _build_ort_inputs(val_ds, l0_vocab, l1_vocab, l0_vsize, l1_vsize)
    reader     = _CalibrationReader(cal_inputs)

    log.info("Quantising to INT8 → %s", int8_path)
    quantize_static(
        model_input          = str(fp32_path),
        model_output         = str(int8_path),
        calibration_data_reader = reader,
        weight_type          = QuantType.QInt8,
    )
    int8_size_mb = int8_path.stat().st_size / 1_048_576
    log.info("INT8 ONNX size: %.2f MB", int8_size_mb)

    # ── 5. Accuracy delta check on test set ────────────────────────────────────
    log.info("Measuring accuracy delta on test set (%d days)", len(test_ds))
    test_inputs = _build_ort_inputs(test_ds, l0_vocab, l1_vocab, l0_vsize, l1_vsize)

    sess_fp32 = ort.InferenceSession(str(fp32_path))
    sess_int8 = ort.InferenceSession(str(int8_path))

    acc_fp32 = _ort_l0_top1(sess_fp32, test_inputs, test_ds, l0_vocab, l1_vocab)
    acc_int8 = _ort_l0_top1(sess_int8, test_inputs, test_ds, l0_vocab, l1_vocab)
    delta    = abs(acc_fp32 - acc_int8)

    log.info("FP32 L0 top-1: %.1f%%  INT8: %.1f%%  delta: %.2f pp",
             acc_fp32 * 100, acc_int8 * 100, delta * 100)

    report = {
        "fp32_path":       str(fp32_path),
        "int8_path":       str(int8_path),
        "fp32_size_mb":    round(fp32_size_mb, 3),
        "int8_size_mb":    round(int8_size_mb, 3),
        "l0_acc_fp32":     acc_fp32,
        "l0_acc_int8":     acc_int8,
        "delta_pp":        delta,
        "delta_limit":     DELTA_LIMIT,
        "delta_passed":    delta <= DELTA_LIMIT,
    }

    out = ckpt_dir / "onnx_export_report.json"
    out.write_text(json.dumps(report, indent=2))
    log.info("ONNX export report → %s", out)

    return report
