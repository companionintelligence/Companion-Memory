"""
HMT Trainer — MAE pre-training (T2.2) and hierarchical fine-tuning (T2.3).

train_l0_mae:
  Masked autoencoder on L0-only sequences.  75% masking, AdamW lr=1e-4,
  cosine decay, early stopping.  Saves l0_mae_checkpoint.pt.

train_hmt_joint:
  Fine-tunes HMTModel (L0+L1) from the L0 checkpoint.  Joint loss:
    L_total = CE(L0) + Σ_c P(L0=c) · CE(L1|L0=c)
  L2 is skipped until Phase 3 (content data required).
  Saves hmt_checkpoint.pt.

Implements T2.2 (CI-Server-apo) and T2.3 (CI-Server-8ms).
"""
from __future__ import annotations

import logging
import math
import random
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR

from ci.config import settings
from ci.model.checkpoints import (
    user_ckpt_dir, l1_vocab_fingerprint, L0_MAE_CKPT, HMT_CKPT,
)
from ci.model.dataset import TokenStreamDataset
from ci.model.transformer import L0MAEModel, HMTModel
from ci.model.vocab import (
    MASK_IDX, PAD_IDX, SOD_IDX, EOD_IDX, Vocab, build_l0_vocab, build_l1_vocab,
)

log = logging.getLogger(__name__)

MASK_RATE  = 0.75
LR         = 1e-4
N_EPOCHS   = 50
PATIENCE   = 7    # early-stopping patience (epochs without val improvement)
WEIGHT_DECAY = 0.01

# Tokens that are never masked (structural tokens)
_NO_MASK = {SOD_IDX, EOD_IDX, PAD_IDX}


def train_l0_mae(
    user_id: str,
    train_ds: TokenStreamDataset,
    val_ds:   TokenStreamDataset,
    device:   Optional[str] = None,
) -> Path:
    """
    Pre-train the L0 MAE model and save the best checkpoint.

    Returns the path to the saved checkpoint.
    """
    if device is None:
        device = "cuda" if torch.cuda.is_available() else (
            "mps" if torch.backends.mps.is_available() else "cpu"
        )
    log.info("Training L0 MAE on device=%s  train=%d val=%d days",
             device, len(train_ds), len(val_ds))

    vocab = build_l0_vocab()
    model = L0MAEModel(vocab_size=len(vocab)).to(device)
    optimiser = AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = CosineAnnealingLR(optimiser, T_max=N_EPOCHS, eta_min=LR / 10)

    ckpt_dir = user_ckpt_dir(user_id, create=True)
    ckpt_path = ckpt_dir / L0_MAE_CKPT

    best_val_loss = math.inf
    patience_counter = 0

    for epoch in range(1, N_EPOCHS + 1):
        train_loss = _run_epoch(model, train_ds, vocab, device, optimiser, training=True)
        val_loss   = _run_epoch(model, val_ds,   vocab, device, optimiser=None, training=False)
        scheduler.step()

        improved = val_loss < best_val_loss - 1e-4
        if improved:
            best_val_loss = val_loss
            patience_counter = 0
            torch.save({
                "epoch": epoch,
                "model_state": model.state_dict(),
                "vocab_size": len(vocab),
                "val_loss": best_val_loss,
            }, ckpt_path)
            log.info("Epoch %d/%d  train=%.4f  val=%.4f  ✓ saved",
                     epoch, N_EPOCHS, train_loss, val_loss)
        else:
            patience_counter += 1
            log.info("Epoch %d/%d  train=%.4f  val=%.4f  (patience %d/%d)",
                     epoch, N_EPOCHS, train_loss, val_loss, patience_counter, PATIENCE)
            if patience_counter >= PATIENCE:
                log.info("Early stopping at epoch %d", epoch)
                break

    log.info("L0 MAE pre-training complete. Best val loss=%.4f  checkpoint=%s",
             best_val_loss, ckpt_path)
    return ckpt_path


# ── Epoch loop ────────────────────────────────────────────────────────────────


def _run_epoch(
    model:     L0MAEModel,
    dataset:   TokenStreamDataset,
    vocab:     Vocab,
    device:    str,
    optimiser: Optional[AdamW],
    training:  bool,
) -> float:
    model.train(training)
    total_loss = 0.0
    n_batches  = 0

    ctx = torch.enable_grad() if training else torch.no_grad()
    with ctx:
        for day_tokens in dataset:
            batch = _prepare_batch(day_tokens, vocab, device)
            if batch is None:
                continue   # day has no maskable L0 tokens

            token_ids, bucket_idxs, padding_mask, targets, mask_positions = batch
            logits = model(token_ids, bucket_idxs, padding_mask)  # (1, T, V)

            # Loss only on masked positions
            loss = _masked_ce_loss(logits, targets, mask_positions)

            if training and optimiser is not None:
                optimiser.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimiser.step()

            total_loss += loss.item()
            n_batches  += 1

    return total_loss / max(n_batches, 1)


def _prepare_batch(
    day_tokens: list[dict],
    vocab:      Vocab,
    device:     str,
) -> Optional[tuple]:
    """
    Convert one day's token list to tensors ready for L0MAEModel.

    Returns None if there are no maskable L0 tokens in the day.
    Operates as a batch of 1 (B=1).
    """
    # Extract L0 tokens + SOD/EOD (skip L1/L2)
    l0_rows = [t for t in day_tokens if t["level"] in ("SOD", "EOD", "L0")]
    if not l0_rows:
        return None

    ids     = [vocab.encode(t["token_id"]) for t in l0_rows]
    buckets = [t["bucket_idx"] for t in l0_rows]

    # Identify maskable positions (not SOD/EOD/PAD)
    maskable = [i for i, idx in enumerate(ids) if idx not in _NO_MASK]
    if not maskable:
        return None

    # Apply masking
    n_mask = max(1, round(len(maskable) * MASK_RATE))
    mask_positions = set(random.sample(maskable, n_mask))

    targets    = list(ids)
    masked_ids = list(ids)
    for pos in mask_positions:
        masked_ids[pos] = MASK_IDX

    t_ids     = torch.tensor([masked_ids], dtype=torch.long,  device=device)
    t_buckets = torch.tensor([buckets],    dtype=torch.long,  device=device)
    t_pad     = torch.zeros((1, len(ids)), dtype=torch.bool,  device=device)
    t_targets = torch.tensor([targets],    dtype=torch.long,  device=device)

    return t_ids, t_buckets, t_pad, t_targets, mask_positions


def _masked_ce_loss(
    logits:         torch.Tensor,   # (1, T, V)
    targets:        torch.Tensor,   # (1, T)
    mask_positions: set[int],
) -> torch.Tensor:
    """Cross-entropy loss averaged over masked positions only."""
    pos_list = sorted(mask_positions)
    logits_m  = logits[0, pos_list, :]      # (n_mask, V)
    targets_m = targets[0, pos_list]         # (n_mask,)
    return nn.functional.cross_entropy(logits_m, targets_m)


# ── T2.3 — Hierarchical joint fine-tuning ────────────────────────────────────

LR_FINETUNE = 5e-5   # lower LR for fine-tuning from pre-trained checkpoint


def train_hmt_joint(
    user_id:  str,
    train_ds: TokenStreamDataset,
    val_ds:   TokenStreamDataset,
    device:   Optional[str] = None,
) -> Path:
    """
    Fine-tune HMTModel (L0+L1) from the L0 MAE checkpoint.

    Joint loss: L_total = CE(L0) + mean_c[ P(L0=c) * CE(L1|L0=c) ]
    L2 deferred until Phase 3.

    Returns path to saved hmt_checkpoint.pt.
    """
    if device is None:
        device = "cuda" if torch.cuda.is_available() else (
            "mps" if torch.backends.mps.is_available() else "cpu"
        )

    l0_vocab = build_l0_vocab()
    l1_vocab = build_l1_vocab(user_id)
    log.info("Joint fine-tune: L0 vocab=%d  L1 vocab=%d  device=%s",
             len(l0_vocab), len(l1_vocab), device)

    model = HMTModel(l0_vocab_size=len(l0_vocab), l1_vocab_size=len(l1_vocab)).to(device)

    # Load L0 backbone weights from MAE checkpoint
    ckpt_dir  = user_ckpt_dir(user_id, create=True)
    mae_ckpt  = ckpt_dir / L0_MAE_CKPT
    if mae_ckpt.exists():
        mae_state = torch.load(mae_ckpt, map_location=device, weights_only=True)["model_state"]
        # Copy weights that match (token_emb, pos_emb, encoder)
        model_state = model.state_dict()
        transferred = {k: v for k, v in mae_state.items() if k in model_state
                       and model_state[k].shape == v.shape}
        model_state.update(transferred)
        model.load_state_dict(model_state)
        log.info("Transferred %d/%d weight tensors from L0 MAE checkpoint",
                 len(transferred), len(mae_state))

    optimiser = AdamW(model.parameters(), lr=LR_FINETUNE, weight_decay=WEIGHT_DECAY)
    scheduler = CosineAnnealingLR(optimiser, T_max=N_EPOCHS, eta_min=LR_FINETUNE / 10)

    ckpt_path    = ckpt_dir / HMT_CKPT
    l1_fp        = l1_vocab_fingerprint(l1_vocab)
    best_val     = math.inf
    patience_ctr = 0

    for epoch in range(1, N_EPOCHS + 1):
        tr_loss = _run_joint_epoch(model, train_ds, l0_vocab, l1_vocab, device,
                                   optimiser, training=True)
        vl_loss = _run_joint_epoch(model, val_ds,   l0_vocab, l1_vocab, device,
                                   optimiser=None,  training=False)
        scheduler.step()

        if vl_loss < best_val - 1e-4:
            best_val     = vl_loss
            patience_ctr = 0
            torch.save({
                "epoch":          epoch,
                "model_state":    model.state_dict(),
                "l0_vocab_size":  len(l0_vocab),
                "l1_vocab_size":  len(l1_vocab),
                "l1_vocab_fingerprint": l1_fp,
                "val_loss":       best_val,
            }, ckpt_path)
            log.info("Epoch %d/%d  train=%.4f  val=%.4f  ✓ saved",
                     epoch, N_EPOCHS, tr_loss, vl_loss)
        else:
            patience_ctr += 1
            log.info("Epoch %d/%d  train=%.4f  val=%.4f  (patience %d/%d)",
                     epoch, N_EPOCHS, tr_loss, vl_loss, patience_ctr, PATIENCE)
            if patience_ctr >= PATIENCE:
                log.info("Early stopping at epoch %d", epoch)
                break

    log.info("HMT joint fine-tuning complete. Best val=%.4f  ckpt=%s", best_val, ckpt_path)
    return ckpt_path


def _run_joint_epoch(
    model:     HMTModel,
    dataset:   TokenStreamDataset,
    l0_vocab:  Vocab,
    l1_vocab:  Vocab,
    device:    str,
    optimiser: Optional[AdamW],
    training:  bool,
) -> float:
    model.train(training)
    total_loss = 0.0
    n_batches  = 0

    ctx = torch.enable_grad() if training else torch.no_grad()
    with ctx:
        for day_tokens in dataset:
            batch = _prepare_joint_batch(day_tokens, l0_vocab, l1_vocab, device)
            if batch is None:
                continue

            token_ids, bucket_idxs, level_ids, padding_mask, l0_targets, l1_targets = batch
            l0_logits, l1_logits = model(token_ids, bucket_idxs, level_ids, padding_mask)

            loss = _joint_loss(l0_logits, l1_logits, l0_targets, l1_targets, level_ids)

            if training and optimiser is not None:
                optimiser.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimiser.step()

            total_loss += loss.item()
            n_batches  += 1

    return total_loss / max(n_batches, 1)


def _prepare_joint_batch(
    day_tokens: list[dict],
    l0_vocab:   Vocab,
    l1_vocab:   Vocab,
    device:     str,
) -> Optional[tuple]:
    """
    Build a joint L0+L1 batch from one day's tokens.

    Returns None if the day has no L1 tokens (no training signal for joint loss).
    Each token gets a level_id: 0=L0/SOD/EOD, 1=L1.
    """
    rows = [t for t in day_tokens if t["level"] in ("SOD", "EOD", "L0", "L1")]
    if not any(t["level"] == "L1" for t in rows):
        return None

    token_ids  = []
    bucket_ids = []
    level_ids  = []
    l0_targets = []
    l1_targets = []

    for t in rows:
        lvl = t["level"]
        bucket = t["bucket_idx"]
        if lvl in ("SOD", "EOD", "L0"):
            idx = l0_vocab.encode(t["token_id"])
            token_ids.append(idx)
            bucket_ids.append(bucket)
            level_ids.append(0)
            l0_targets.append(idx)
            l1_targets.append(PAD_IDX)   # ignored at loss time
        else:  # L1
            idx = l1_vocab.encode(t["token_id"])
            token_ids.append(idx)
            bucket_ids.append(bucket)
            level_ids.append(1)
            l0_targets.append(PAD_IDX)   # ignored at loss time
            l1_targets.append(idx)

    t_tok  = torch.tensor([token_ids],  dtype=torch.long, device=device)
    t_bkt  = torch.tensor([bucket_ids], dtype=torch.long, device=device)
    t_lvl  = torch.tensor([level_ids],  dtype=torch.long, device=device)
    t_pad  = torch.zeros((1, len(rows)), dtype=torch.bool, device=device)
    t_l0   = torch.tensor([l0_targets], dtype=torch.long, device=device)
    t_l1   = torch.tensor([l1_targets], dtype=torch.long, device=device)

    return t_tok, t_bkt, t_lvl, t_pad, t_l0, t_l1


def _joint_loss(
    l0_logits:  torch.Tensor,   # (1, T, V_l0)
    l1_logits:  torch.Tensor,   # (1, T, V_l1)
    l0_targets: torch.Tensor,   # (1, T)
    l1_targets: torch.Tensor,   # (1, T)
    level_ids:  torch.Tensor,   # (1, T)
) -> torch.Tensor:
    """
    L_total = CE(L0 positions) + P(L0) * CE(L1 positions)

    P(L0) is the softmax probability of the actual L0 class at positions
    immediately preceding each L1 token — approximated here as a uniform
    weight of 1.0 for simplicity (full probability weighting deferred to
    calibration phase T2.4).
    """
    B = 1
    l0_pos = (level_ids[0] == 0).nonzero(as_tuple=True)[0]
    l1_pos = (level_ids[0] == 1).nonzero(as_tuple=True)[0]

    l0_loss = torch.tensor(0.0, device=l0_logits.device)
    l1_loss = torch.tensor(0.0, device=l1_logits.device)

    if l0_pos.numel() > 0:
        tgt = l0_targets[0, l0_pos]
        valid = tgt != PAD_IDX
        if valid.any():
            l0_loss = nn.functional.cross_entropy(
                l0_logits[0, l0_pos[valid]], tgt[valid]
            )

    if l1_pos.numel() > 0:
        tgt = l1_targets[0, l1_pos]
        valid = tgt != PAD_IDX
        if valid.any():
            l1_loss = nn.functional.cross_entropy(
                l1_logits[0, l1_pos[valid]], tgt[valid]
            )

    return l0_loss + l1_loss
