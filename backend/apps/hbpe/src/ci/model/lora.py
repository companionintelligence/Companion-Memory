"""
LoRA adapter — rank-8 low-rank adaptation for HMT attention projections.

Applies LoRA to Q/K/V (combined in_proj_weight) and O (out_proj.weight)
in each TransformerEncoderLayer of HMTModel, leaving all other weights frozen.

At initialisation the delta is exactly zero (B=zeros, A=kaiming-uniform),
so the adapted model is numerically identical to the base at step 0.

Usage:
    model = HMTModel(...)
    model.load_state_dict(torch.load(...))
    apply_lora(model)                     # freeze backbone, inject LoRAMHA
    optimizer = AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=5e-5
    )
    # … training loop …
    save_adapter(model, path)

    # Inference — merge for zero-overhead forward:
    merge_adapter(model)

Implements T3.1 (CI-Server-6rw).
"""
from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

from ci.model.transformer import HMTModel

log = logging.getLogger(__name__)

LORA_RANK  = 8
LORA_ALPHA = 16.0   # effective scale = alpha / rank = 2.0


# ── LoRA-aware MHA wrapper ─────────────────────────────────────────────────────

class LoRAMHA(nn.Module):
    """
    Drop-in replacement for nn.MultiheadAttention with rank-r LoRA on
    Q/K/V (combined in_proj_weight) and O (out_proj.weight).

    The LoRA delta is applied by computing effective weights at each
    forward pass rather than mutating the frozen base weights in-place,
    so gradients flow correctly to qkv_A/B and o_A/B.
    """

    def __init__(
        self,
        base:  nn.MultiheadAttention,
        rank:  int,
        scale: float,
    ) -> None:
        super().__init__()
        self.base  = base
        self.scale = scale
        d = base.embed_dim

        # A init: kaiming-uniform  B init: zeros  →  delta = B@A = 0 at step 0
        self.qkv_A = nn.Parameter(torch.empty(rank, d))
        self.qkv_B = nn.Parameter(torch.zeros(3 * d, rank))
        self.o_A   = nn.Parameter(torch.empty(rank, d))
        self.o_B   = nn.Parameter(torch.zeros(d, rank))

        nn.init.kaiming_uniform_(self.qkv_A, a=math.sqrt(5))
        nn.init.kaiming_uniform_(self.o_A,   a=math.sqrt(5))

    # nn.TransformerEncoder reads layer.self_attn.batch_first directly
    @property
    def batch_first(self) -> bool:
        return self.base.batch_first

    def forward(
        self,
        query:            torch.Tensor,
        key:              torch.Tensor,
        value:            torch.Tensor,
        key_padding_mask: Optional[torch.Tensor] = None,
        need_weights:     bool = False,
        attn_mask:        Optional[torch.Tensor] = None,
        is_causal:        bool = False,
    ) -> tuple[torch.Tensor, Optional[torch.Tensor]]:
        # nn.TransformerEncoderLayer (batch_first=True) passes (B,T,E).
        # F.multi_head_attention_forward expects (T,B,E); transpose if needed.
        if self.base.batch_first:
            query, key, value = (x.transpose(1, 0) for x in (query, key, value))

        W_qkv = self.base.in_proj_weight + self.scale * (self.qkv_B @ self.qkv_A)
        W_o   = self.base.out_proj.weight + self.scale * (self.o_B   @ self.o_A)

        attn_out, weights = F.multi_head_attention_forward(
            query, key, value,
            embed_dim_to_check = self.base.embed_dim,
            num_heads          = self.base.num_heads,
            in_proj_weight     = W_qkv,
            in_proj_bias       = self.base.in_proj_bias,
            bias_k             = self.base.bias_k,
            bias_v             = self.base.bias_v,
            add_zero_attn      = self.base.add_zero_attn,
            dropout_p          = self.base.dropout if self.training else 0.0,
            out_proj_weight    = W_o,
            out_proj_bias      = self.base.out_proj.bias,
            training           = self.training,
            key_padding_mask   = key_padding_mask,
            need_weights       = need_weights,
            attn_mask          = attn_mask,
            is_causal          = is_causal,
        )

        if self.base.batch_first:
            attn_out = attn_out.transpose(1, 0)

        return attn_out, weights


# ── Public API ─────────────────────────────────────────────────────────────────

def apply_lora(
    model: HMTModel,
    rank:  int   = LORA_RANK,
    alpha: float = LORA_ALPHA,
) -> HMTModel:
    """
    Freeze all backbone parameters and inject LoRAMHA into every encoder layer.

    After this call, only the LoRA parameters (qkv_A, qkv_B, o_A, o_B) have
    requires_grad=True.  Modifies model in-place and returns it.
    """
    scale = alpha / rank

    for p in model.parameters():
        p.requires_grad_(False)

    for i, layer in enumerate(model.encoder.layers):
        layer.self_attn = LoRAMHA(layer.self_attn, rank=rank, scale=scale)
        log.debug("Injected LoRAMHA into encoder layer %d", i)

    adapter_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params   = sum(p.numel() for p in model.parameters())
    log.info(
        "LoRA applied — %d adapter params / %d total (%.1f%%)",
        adapter_params, total_params, 100 * adapter_params / max(total_params, 1),
    )
    return model


def save_adapter(model: HMTModel, path: Path) -> None:
    """Save only the trainable (LoRA) parameters to *path*."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    adapter = {
        name: param.detach().clone()
        for name, param in model.named_parameters()
        if param.requires_grad
    }
    torch.save(
        {"lora_rank": LORA_RANK, "lora_alpha": LORA_ALPHA, "adapter": adapter},
        path,
    )
    n_params = sum(v.numel() for v in adapter.values())
    log.info("Saved LoRA adapter → %s  (%d params)", path, n_params)


def load_adapter(model: HMTModel, path: Path) -> HMTModel:
    """
    Load LoRA parameters from *path* and apply them to *model*.

    If LoRA has not yet been applied to the model, apply_lora() is called
    first using the rank/alpha stored in the checkpoint.
    """
    path = Path(path)
    ckpt  = torch.load(path, map_location="cpu", weights_only=True)
    rank  = ckpt.get("lora_rank",  LORA_RANK)
    alpha = ckpt.get("lora_alpha", LORA_ALPHA)

    if not isinstance(model.encoder.layers[0].self_attn, LoRAMHA):
        apply_lora(model, rank=rank, alpha=alpha)

    missing, unexpected = model.load_state_dict(ckpt["adapter"], strict=False)
    if unexpected:
        log.warning("Unexpected adapter keys: %s", unexpected)
    log.info("Loaded LoRA adapter ← %s", path)
    return model


def merge_adapter(model: HMTModel) -> HMTModel:
    """
    Permanently incorporate the LoRA delta into the backbone weights and
    restore plain nn.MultiheadAttention modules.

    Call before ONNX export or whenever zero-overhead inference is needed.
    The adapter can no longer be fine-tuned after merging.
    """
    for layer in model.encoder.layers:
        lora = layer.self_attn
        if not isinstance(lora, LoRAMHA):
            continue
        with torch.no_grad():
            lora.base.in_proj_weight.data  += lora.scale * (lora.qkv_B @ lora.qkv_A)
            lora.base.out_proj.weight.data += lora.scale * (lora.o_B   @ lora.o_A)
        layer.self_attn = lora.base

    # Re-enable all gradients (backbone is no longer frozen)
    for p in model.parameters():
        p.requires_grad_(True)

    log.info("LoRA adapter merged into backbone weights")
    return model
