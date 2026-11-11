"""
Nightly LoRA fine-tune — one epoch of adapter training on yesterday's tokens.

Fine-tunes only the LoRA adapter parameters (backbone frozen) using the
tokens serialised for the given date.  Designed to run in < 5 minutes on CPU.

Loss is the same joint CE used in T2.3: CE(L0 positions) + CE(L1 positions).
When ci.prediction_log is available (Phase 4+), callers can restrict the
dataset to mispredicted buckets before invoking this function.

Adapter checkpoint path: {models_dir}/hmt/lora_{user_id}.pt

Implements T3.2 (CI-Server-76y).
"""

from __future__ import annotations

import datetime
import logging
import math

import torch
import torch.nn.functional as F
from torch.optim import AdamW

from ci.hbpe.model.calibration import _build_full_batch
from ci.hbpe.model.checkpoints import (
    HMT_CALIBRATED,
    architecture_fingerprint,
    l1_vocab_fingerprint,
    user_ckpt_dir,
)
from ci.hbpe.model.dataset import TokenStreamDataset
from ci.hbpe.model.evaluator import _load_calibrated
from ci.hbpe.model.lora import apply_lora, load_adapter, save_adapter
from ci.hbpe.model.train_io import (
    AdapterMismatch,
    adapter_meta,
    archive_previous,
    file_digest,
    is_finite,
    mean_step_loss,
    resolve_device,
    seed_everything,
)
from ci.hbpe.model.vocab import (
    EOD_IDX,
    PAD_IDX,
    SOD_IDX,
    build_l0_vocab,
    build_l1_vocab,
)

log = logging.getLogger(__name__)

LR_LORA = 5e-5
WEIGHT_DECAY = 0.01

_SPECIAL_IDX = {PAD_IDX, SOD_IDX, EOD_IDX}


def fine_tune_nightly(
    user_id: str,
    date: datetime.date,
    device: str | None = None,
) -> dict:
    """
    Run one epoch of LoRA fine-tuning on *date*'s token stream.

    Returns a report dict with keys:
      date, n_days, n_l0_tokens, n_l1_tokens, loss, adapter_path
    """
    device = resolve_device(device)
    # Same user, same day, same data gives the same adapter.
    seed_everything(date.toordinal())

    l0_vocab = build_l0_vocab()
    l1_vocab = build_l1_vocab(user_id)

    # ── Load backbone ──────────────────────────────────────────────────────────
    model, _temperature = _load_calibrated(user_id, l0_vocab, l1_vocab, device)

    # ── Apply LoRA (freeze backbone, inject trainable deltas) ──────────────────
    apply_lora(model)

    # ── Load existing adapter if present ──────────────────────────────────────
    ckpt_dir = user_ckpt_dir(user_id, create=True)
    adapter_path = ckpt_dir / f"lora_{user_id}.pt"
    # An adapter is only valid against the base it was trained on. A retrained
    # base (bootstrap) or a grown model leaves the old adapter stale.
    meta = adapter_meta(
        architecture=architecture_fingerprint(),
        l1_vocab_fingerprint=l1_vocab_fingerprint(l1_vocab),
        base_digest=file_digest(ckpt_dir / HMT_CALIBRATED),
    )
    if adapter_path.exists():
        try:
            load_adapter(model, adapter_path, strict=True, expect=meta)
            log.info("Resumed adapter from %s", adapter_path)
        except AdapterMismatch as exc:
            kept = archive_previous(adapter_path)
            log.warning(
                "Stale adapter for %s (%s); archived to %s, restarting from zero delta",
                user_id,
                exc,
                kept,
            )
    else:
        log.info("No prior adapter found, starting from zero delta")

    # ── Dataset: single day ────────────────────────────────────────────────────
    ds = TokenStreamDataset(user_id, [date])
    if len(ds) == 0:
        log.warning("No token data for %s on %s — skipping fine-tune", user_id, date)
        return {
            "date": str(date),
            "n_days": 0,
            "n_l0_tokens": 0,
            "n_l1_tokens": 0,
            "loss": None,
            "adapter_path": str(adapter_path),
        }

    # ── Optimiser — only adapter params ───────────────────────────────────────
    adapter_params = [p for p in model.parameters() if p.requires_grad]
    optimizer = AdamW(adapter_params, lr=LR_LORA, weight_decay=WEIGHT_DECAY)

    # ── One epoch ─────────────────────────────────────────────────────────────
    model.train()
    total_loss = 0.0
    n_l0_tokens = 0
    n_l1_tokens = 0
    n_steps = 0
    n_skipped = 0

    for day_tokens in ds:
        batch = _build_full_batch(day_tokens, l0_vocab, l1_vocab, device)
        if batch is None:
            continue

        token_ids, bucket_idxs, level_ids, padding_mask, l0_targets, l1_targets = batch

        optimizer.zero_grad()
        l0_logits, l1_logits = model(token_ids, bucket_idxs, level_ids, padding_mask)

        loss = torch.tensor(0.0, device=device)

        # L0 CE loss
        l0_pos = (level_ids[0] == 0).nonzero(as_tuple=True)[0]
        if l0_pos.numel() > 0:
            tgt = l0_targets[0, l0_pos]
            valid = (tgt != PAD_IDX) & ~torch.isin(
                tgt, torch.tensor(list(_SPECIAL_IDX), device=device)
            )
            if valid.any():
                loss = loss + F.cross_entropy(l0_logits[0, l0_pos[valid]], tgt[valid])
                n_l0_tokens += int(valid.sum())

        # L1 CE loss
        l1_pos = (level_ids[0] == 1).nonzero(as_tuple=True)[0]
        if l1_pos.numel() > 0:
            tgt1 = l1_targets[0, l1_pos]
            valid1 = tgt1 != PAD_IDX
            if valid1.any():
                loss = loss + F.cross_entropy(
                    l1_logits[0, l1_pos[valid1]], tgt1[valid1]
                )
                n_l1_tokens += int(valid1.sum())

        if loss.item() > 0:
            if not torch.isfinite(loss):
                n_skipped += 1
                log.warning("Non-finite loss on %s, skipping step", date)
                continue
            loss.backward()
            torch.nn.utils.clip_grad_norm_(adapter_params, max_norm=1.0)
            optimizer.step()
            total_loss += loss.item()
            n_steps += 1

    mean_loss = mean_step_loss(total_loss, n_steps)
    log.info(
        "Nightly fine-tune, date=%s  L0=%d  L1=%d  steps=%d  loss=%s",
        date,
        n_l0_tokens,
        n_l1_tokens,
        n_steps,
        f"{mean_loss:.4f}" if mean_loss is not None else "n/a",
    )

    # ── Save updated adapter ───────────────────────────────────────────────────
    # Never replace a good adapter with one from a run that took no steps or
    # produced a non-finite loss. Keep the previous version for rollback.
    model.eval()
    saved = False
    if n_steps > 0 and is_finite(mean_loss) and math.isfinite(total_loss):
        archive_previous(adapter_path)
        save_adapter(model, adapter_path, meta=meta)
        saved = True
    else:
        log.warning("Adapter for %s left unchanged (steps=%d)", user_id, n_steps)

    return {
        "date": str(date),
        "n_days": 1,
        "n_l0_tokens": n_l0_tokens,
        "n_l1_tokens": n_l1_tokens,
        "steps": n_steps,
        "skipped_nonfinite": n_skipped,
        "loss": mean_loss,
        "saved": saved,
        "adapter_path": str(adapter_path),
    }
