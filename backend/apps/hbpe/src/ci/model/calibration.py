"""
Calibration — temperature scaling + ECE measurement for the HMT model.

Steps (CI-HBPE-SPEC-001 §T2.4):
  1. Load hmt_checkpoint.pt.
  2. Find optimal temperature scalar T on val set (minimises NLL).
  3. Measure Expected Calibration Error (ECE) per level before and after scaling.
  4. Save hmt_calibrated.pt (same weights + temperature parameter).
  5. Write calibration_report.json.

Temperature scaling: calibrated_probs = softmax(logits / T).
ECE target: < 0.08 per level per spec §7.2.

Implements T2.4 (CI-Server-cmf).
"""
from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Optional

import torch
import torch.nn.functional as F

from ci.config import settings
from ci.model.dataset import TokenStreamDataset
from ci.model.transformer import HMTModel
from ci.model.vocab import PAD_IDX, SOD_IDX, EOD_IDX, Vocab, build_l0_vocab, build_l1_vocab

log = logging.getLogger(__name__)

ECE_TARGET   = 0.08
N_BINS       = 10
T_SEARCH_MIN = 0.1
T_SEARCH_MAX = 5.0
T_SEARCH_STEPS = 100

_SPECIAL_IDX = {PAD_IDX, SOD_IDX, EOD_IDX}


def calibrate(
    user_id:     str,
    val_ds:      TokenStreamDataset,
    device:      Optional[str] = None,
) -> dict:
    """
    Run temperature scaling on the val set.

    Returns a calibration report dict and saves hmt_calibrated.pt.
    """
    if device is None:
        device = "cuda" if torch.cuda.is_available() else (
            "mps" if torch.backends.mps.is_available() else "cpu"
        )

    l0_vocab = build_l0_vocab()
    l1_vocab = build_l1_vocab(user_id)

    model = _load_hmt(user_id, l0_vocab, l1_vocab, device)

    # Measure ECE before scaling
    ece_before = _measure_ece(model, val_ds, l0_vocab, l1_vocab, device, temperature=1.0)
    log.info("ECE before scaling — L0: %.4f  L1: %.4f",
             ece_before["l0"], ece_before["l1"])

    # Find optimal temperature via grid search on val NLL
    best_T, best_nll = _find_temperature(model, val_ds, l0_vocab, l1_vocab, device)
    log.info("Optimal temperature T=%.4f  val_NLL=%.4f", best_T, best_nll)

    # Measure ECE after scaling
    ece_after = _measure_ece(model, val_ds, l0_vocab, l1_vocab, device, temperature=best_T)
    log.info("ECE after  scaling — L0: %.4f  L1: %.4f",
             ece_after["l0"], ece_after["l1"])

    # Save calibrated checkpoint (same weights, add temperature)
    ckpt_dir = Path(settings.models_dir) / "hmt"
    src_ckpt = torch.load(ckpt_dir / "hmt_checkpoint.pt", map_location=device,
                          weights_only=True)
    src_ckpt["temperature"] = best_T
    cal_path = ckpt_dir / "hmt_calibrated.pt"
    torch.save(src_ckpt, cal_path)
    log.info("Saved calibrated checkpoint → %s", cal_path)

    report = {
        "temperature": best_T,
        "ece_before":  ece_before,
        "ece_after":   ece_after,
        "ece_target":  ECE_TARGET,
        "l0_passed":   ece_after["l0"] < ECE_TARGET,
        "l1_passed":   ece_after["l1"] < ECE_TARGET,
    }

    out = ckpt_dir / "calibration_report.json"
    out.write_text(json.dumps(report, indent=2))
    log.info("Calibration report → %s", out)

    return report


# ── Internals ─────────────────────────────────────────────────────────────────


def _load_hmt(user_id: str, l0_vocab: Vocab, l1_vocab: Vocab, device: str) -> HMTModel:
    ckpt_path = Path(settings.models_dir) / "hmt" / "hmt_checkpoint.pt"
    ckpt = torch.load(ckpt_path, map_location=device, weights_only=True)
    model = HMTModel(l0_vocab_size=len(l0_vocab), l1_vocab_size=len(l1_vocab)).to(device)
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    return model


def _find_temperature(
    model:    HMTModel,
    dataset:  TokenStreamDataset,
    l0_vocab: Vocab,
    l1_vocab: Vocab,
    device:   str,
) -> tuple[float, float]:
    """Grid search for the temperature minimising NLL on the dataset."""
    best_T   = 1.0
    best_nll = math.inf

    temperatures = [
        T_SEARCH_MIN + (T_SEARCH_MAX - T_SEARCH_MIN) * i / (T_SEARCH_STEPS - 1)
        for i in range(T_SEARCH_STEPS)
    ]

    for T in temperatures:
        nll = _compute_nll(model, dataset, l0_vocab, l1_vocab, device, T)
        if nll < best_nll:
            best_nll = nll
            best_T   = T

    return best_T, best_nll


def _compute_nll(
    model:    HMTModel,
    dataset:  TokenStreamDataset,
    l0_vocab: Vocab,
    l1_vocab: Vocab,
    device:   str,
    temperature: float,
) -> float:
    """Mean NLL over all non-special tokens in the dataset."""
    total_nll = 0.0
    n_tokens  = 0

    with torch.no_grad():
        for day_tokens in dataset:
            batch = _build_full_batch(day_tokens, l0_vocab, l1_vocab, device)
            if batch is None:
                continue
            token_ids, bucket_idxs, level_ids, padding_mask, l0_targets, l1_targets = batch
            l0_logits, l1_logits = model(token_ids, bucket_idxs, level_ids, padding_mask)

            # L0 NLL
            l0_pos = (level_ids[0] == 0).nonzero(as_tuple=True)[0]
            tgt = l0_targets[0, l0_pos]
            valid = (tgt != PAD_IDX) & ~torch.isin(tgt, torch.tensor(
                list(_SPECIAL_IDX), device=device))
            if valid.any():
                log_probs = F.log_softmax(l0_logits[0, l0_pos[valid]] / temperature, dim=-1)
                nll = F.nll_loss(log_probs, tgt[valid], reduction="sum")
                total_nll += nll.item()
                n_tokens  += valid.sum().item()

            # L1 NLL
            l1_pos = (level_ids[0] == 1).nonzero(as_tuple=True)[0]
            if l1_pos.numel() > 0:
                tgt1 = l1_targets[0, l1_pos]
                valid1 = tgt1 != PAD_IDX
                if valid1.any():
                    log_probs1 = F.log_softmax(l1_logits[0, l1_pos[valid1]] / temperature, dim=-1)
                    nll1 = F.nll_loss(log_probs1, tgt1[valid1], reduction="sum")
                    total_nll += nll1.item()
                    n_tokens  += valid1.sum().item()

    return total_nll / max(n_tokens, 1)


def _measure_ece(
    model:       HMTModel,
    dataset:     TokenStreamDataset,
    l0_vocab:    Vocab,
    l1_vocab:    Vocab,
    device:      str,
    temperature: float,
) -> dict[str, float]:
    """Compute ECE for L0 and L1 via equal-width confidence bins."""
    bins_l0 = [{"conf": 0.0, "acc": 0.0, "n": 0} for _ in range(N_BINS)]
    bins_l1 = [{"conf": 0.0, "acc": 0.0, "n": 0} for _ in range(N_BINS)]

    with torch.no_grad():
        for day_tokens in dataset:
            batch = _build_full_batch(day_tokens, l0_vocab, l1_vocab, device)
            if batch is None:
                continue
            token_ids, bucket_idxs, level_ids, padding_mask, l0_targets, l1_targets = batch
            l0_logits, l1_logits = model(token_ids, bucket_idxs, level_ids, padding_mask)

            _accumulate_ece_bins(
                l0_logits[0], l0_targets[0], level_ids[0], 0,
                bins_l0, temperature, device,
            )
            _accumulate_ece_bins(
                l1_logits[0], l1_targets[0], level_ids[0], 1,
                bins_l1, temperature, device,
            )

    return {
        "l0": _ece_from_bins(bins_l0),
        "l1": _ece_from_bins(bins_l1),
    }


def _accumulate_ece_bins(logits, targets, level_ids, level, bins, temperature, device):
    pos = (level_ids == level).nonzero(as_tuple=True)[0]
    if pos.numel() == 0:
        return
    tgt = targets[pos]
    special = torch.tensor(list(_SPECIAL_IDX), device=device)
    valid = (tgt != PAD_IDX) & ~torch.isin(tgt, special)
    if not valid.any():
        return
    probs = F.softmax(logits[pos[valid]] / temperature, dim=-1)
    conf, pred = probs.max(dim=-1)
    correct = (pred == tgt[valid]).float()
    for c, acc in zip(conf.tolist(), correct.tolist()):
        b = min(int(c * N_BINS), N_BINS - 1)
        bins[b]["conf"] += c
        bins[b]["acc"]  += acc
        bins[b]["n"]    += 1


def _ece_from_bins(bins: list[dict]) -> float:
    total_n = sum(b["n"] for b in bins)
    if total_n == 0:
        return 0.0
    ece = sum(
        (b["n"] / total_n) * abs(b["conf"] / b["n"] - b["acc"] / b["n"])
        for b in bins if b["n"] > 0
    )
    return ece


def _build_full_batch(day_tokens, l0_vocab, l1_vocab, device):
    """Build a full (unmasked) batch for calibration/evaluation."""
    rows = [t for t in day_tokens if t["level"] in ("SOD", "EOD", "L0", "L1")]
    if not any(t["level"] == "L1" for t in rows):
        return None

    token_ids, bucket_ids, level_ids, l0_targets, l1_targets = [], [], [], [], []
    for t in rows:
        lvl = t["level"]
        bucket = t["bucket_idx"]
        if lvl in ("SOD", "EOD", "L0"):
            idx = l0_vocab.encode(t["token_id"])
            token_ids.append(idx);  bucket_ids.append(bucket)
            level_ids.append(0);    l0_targets.append(idx);  l1_targets.append(PAD_IDX)
        else:
            idx = l1_vocab.encode(t["token_id"])
            token_ids.append(idx);  bucket_ids.append(bucket)
            level_ids.append(1);    l0_targets.append(PAD_IDX);  l1_targets.append(idx)

    t_tok = torch.tensor([token_ids],  dtype=torch.long, device=device)
    t_bkt = torch.tensor([bucket_ids], dtype=torch.long, device=device)
    t_lvl = torch.tensor([level_ids],  dtype=torch.long, device=device)
    t_pad = torch.zeros((1, len(rows)), dtype=torch.bool, device=device)
    t_l0  = torch.tensor([l0_targets], dtype=torch.long, device=device)
    t_l1  = torch.tensor([l1_targets], dtype=torch.long, device=device)
    return t_tok, t_bkt, t_lvl, t_pad, t_l0, t_l1
