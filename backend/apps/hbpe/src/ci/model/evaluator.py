"""
Evaluator — measures L0 top-1 and L1 top-3 accuracy on the test set.

Evaluation protocol (CI-HBPE-SPEC-001 §T2.5):
  For each day in the test set:
    • Mask each non-special token one at a time (leave-one-out).
    • Run the model with remaining tokens as context.
    • L0: correct if argmax == true label (top-1).
    • L1: correct if true label is in top-3 predicted clusters.

L2 metrics are skipped — no content data in this environment.

Targets: L0 top-1 ≥ 75%,  L1 top-3 ≥ 65%  (CI-HBPE-SPEC-001 §7.2).

Implements T2.5 (CI-Server-stt).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import torch
import torch.nn.functional as F

from ci.config import settings
from ci.model.calibration import _build_full_batch
from ci.model.dataset import TokenStreamDataset
from ci.model.transformer import HMTModel
from ci.model.vocab import (
    MASK_IDX, PAD_IDX, SOD_IDX, EOD_IDX,
    Vocab, build_l0_vocab, build_l1_vocab,
)

log = logging.getLogger(__name__)

L0_TOP1_TARGET = 0.75
L1_TOP3_TARGET = 0.65

_SPECIAL_IDX = {PAD_IDX, SOD_IDX, EOD_IDX, MASK_IDX}


def evaluate(
    user_id: str,
    test_ds:  TokenStreamDataset,
    device:   Optional[str] = None,
) -> dict:
    """
    Run the full evaluation suite on the test split.

    Loads hmt_calibrated.pt (falls back to hmt_checkpoint.pt if not found).
    Returns report dict and writes eval_report.json to models_dir/hmt/.
    """
    if device is None:
        device = "cuda" if torch.cuda.is_available() else (
            "mps" if torch.backends.mps.is_available() else "cpu"
        )

    l0_vocab = build_l0_vocab()
    l1_vocab = build_l1_vocab(user_id)
    model, temperature = _load_calibrated(user_id, l0_vocab, l1_vocab, device)

    log.info("Evaluating on %d test days  T=%.4f  device=%s",
             len(test_ds), temperature, device)

    l0_correct = l0_total = 0
    l1_top3_correct = l1_total = 0

    with torch.no_grad():
        for day_tokens in test_ds:
            rows = [t for t in day_tokens if t["level"] in ("SOD", "EOD", "L0", "L1")]

            # Leave-one-out evaluation per maskable token
            for i, tok in enumerate(rows):
                if tok["level"] not in ("L0", "L1"):
                    continue

                masked_rows = list(rows)
                if tok["level"] == "L0":
                    masked_rows[i] = {**tok, "token_id": "<MASK>"}
                else:
                    masked_rows[i] = {**tok, "token_id": "<MASK>"}

                batch = _build_full_batch(masked_rows, l0_vocab, l1_vocab, device)
                if batch is None:
                    continue

                token_ids, bucket_idxs, level_ids, padding_mask, _, _ = batch
                # Inject MASK token at position i
                if tok["level"] == "L0":
                    token_ids[0, i] = MASK_IDX
                else:
                    token_ids[0, i] = MASK_IDX

                l0_logits, l1_logits = model(token_ids, bucket_idxs, level_ids, padding_mask)

                if tok["level"] == "L0":
                    true_idx = l0_vocab.encode(tok["token_id"])
                    if true_idx in _SPECIAL_IDX:
                        continue
                    logits_i  = l0_logits[0, i] / temperature
                    pred_top1 = int(logits_i.argmax())
                    l0_correct += int(pred_top1 == true_idx)
                    l0_total   += 1

                else:  # L1
                    true_idx = l1_vocab.encode(tok["token_id"])
                    if true_idx in _SPECIAL_IDX:
                        continue
                    logits_i = l1_logits[0, i] / temperature
                    top3     = logits_i.topk(min(3, logits_i.shape[-1])).indices.tolist()
                    l1_top3_correct += int(true_idx in top3)
                    l1_total        += 1

    l0_acc  = l0_correct  / max(l0_total,  1)
    l1_acc3 = l1_top3_correct / max(l1_total, 1)

    report = {
        "l0_top1_accuracy":  l0_acc,
        "l0_top1_target":    L0_TOP1_TARGET,
        "l0_top1_passed":    l0_acc  >= L0_TOP1_TARGET,
        "l0_total_tokens":   l0_total,
        "l1_top3_accuracy":  l1_acc3,
        "l1_top3_target":    L1_TOP3_TARGET,
        "l1_top3_passed":    l1_acc3 >= L1_TOP3_TARGET,
        "l1_total_tokens":   l1_total,
        "l2_recall_at_5":    None,
        "l2_note":           "skipped — no ci.content data in this environment",
    }

    log.info("L0 top-1: %.1f%%  (%d/%d)  target=%.0f%%  %s",
             l0_acc * 100, l0_correct, l0_total, L0_TOP1_TARGET * 100,
             "✓" if report["l0_top1_passed"] else "✗")
    log.info("L1 top-3: %.1f%%  (%d/%d)  target=%.0f%%  %s",
             l1_acc3 * 100, l1_top3_correct, l1_total, L1_TOP3_TARGET * 100,
             "✓" if report["l1_top3_passed"] else "✗")

    out = Path(settings.models_dir) / "hmt" / "eval_report.json"
    out.write_text(json.dumps(report, indent=2, default=str))
    log.info("Eval report → %s", out)

    return report


def _load_calibrated(
    user_id:  str,
    l0_vocab: Vocab,
    l1_vocab: Vocab,
    device:   str,
) -> tuple[HMTModel, float]:
    ckpt_dir = Path(settings.models_dir) / "hmt"
    cal_path = ckpt_dir / "hmt_calibrated.pt"
    src_path = ckpt_dir / "hmt_checkpoint.pt"
    path = cal_path if cal_path.exists() else src_path

    ckpt  = torch.load(path, map_location=device, weights_only=True)
    T     = float(ckpt.get("temperature", 1.0))
    model = HMTModel(l0_vocab_size=len(l0_vocab), l1_vocab_size=len(l1_vocab)).to(device)
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    return model, T
