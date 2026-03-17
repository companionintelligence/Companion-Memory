"""
HMT backbone — Hierarchical Multi-Scale Transformer.

L0MAEModel  — L0-only masked autoencoder (T2.2 pre-training).
HMTModel    — Full hierarchical model with L0 encoder + L1 embedding layer (T2.3).

Architecture:
  • Token embedding tables per level (L0 vocab, L1 vocab)
  • Shared bucket position embedding (48 × d_model)
  • TransformerEncoder shared backbone (n_layers, n_heads, d_ff)
  • L0 + L1 flat linear output heads (nn.Linear)

Kept intentionally small (d_model=64, n_layers=2) because the seed corpus
is ~62 training days — a larger model would overfit immediately.

Implements T2.2 (CI-Server-apo) and T2.3 (CI-Server-8ms).
"""
from __future__ import annotations

import torch
import torch.nn as nn

from ci.model.vocab import MASK_IDX, PAD_IDX

# Default hyperparameters — small by design for a 90-day corpus
D_MODEL   = 64
N_HEADS   = 4
N_LAYERS  = 2
D_FF      = 128
DROPOUT   = 0.1
MAX_BUCKETS = 48


class L0MAEModel(nn.Module):
    """
    Masked Autoencoder for L0 token sequences.

    Input:
      token_ids   (B, T) int64  — L0 token indices (some replaced with MASK_IDX)
      bucket_idxs (B, T) int64  — 30-min bucket position for each token (0..47)
      padding_mask (B, T) bool  — True where tokens are PAD

    Output:
      logits (B, T, vocab_size) — unnormalised log-probs over L0 vocab
    """

    def __init__(self, vocab_size: int) -> None:
        super().__init__()
        self.token_emb   = nn.Embedding(vocab_size, D_MODEL, padding_idx=PAD_IDX)
        self.pos_emb     = nn.Embedding(MAX_BUCKETS, D_MODEL)
        self.dropout     = nn.Dropout(DROPOUT)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=D_MODEL,
            nhead=N_HEADS,
            dim_feedforward=D_FF,
            dropout=DROPOUT,
            batch_first=True,
            norm_first=True,   # pre-LN for stability on small corpora
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=N_LAYERS)
        self.head    = nn.Linear(D_MODEL, vocab_size)

        self._init_weights()

    def _init_weights(self) -> None:
        nn.init.normal_(self.token_emb.weight, std=0.02)
        nn.init.normal_(self.pos_emb.weight,   std=0.02)
        nn.init.zeros_(self.head.bias)

    def forward(
        self,
        token_ids:    torch.Tensor,   # (B, T)
        bucket_idxs:  torch.Tensor,   # (B, T)
        padding_mask: torch.Tensor,   # (B, T) bool
    ) -> torch.Tensor:                # (B, T, vocab_size)
        x = self.token_emb(token_ids) + self.pos_emb(bucket_idxs)
        x = self.dropout(x)
        x = self.encoder(x, src_key_padding_mask=padding_mask)
        return self.head(x)


class HMTModel(nn.Module):
    """
    Full Hierarchical Multi-Scale Transformer with L0 + L1 levels.

    Shares the TransformerEncoder backbone with L0MAEModel.
    L0 and L1 tokens are interleaved in the input sequence; the encoder
    processes them jointly.  Output heads are factored per level.

    Input (per forward call — one day, B=1):
      token_ids    (B, T) — mixed L0/L1 token indices
      bucket_idxs  (B, T) — bucket position for each token
      level_ids    (B, T) — 0=L0, 1=L1 (level embedding)
      padding_mask (B, T) bool

    Output:
      l0_logits  (B, T, V_l0)
      l1_logits  (B, T, V_l1)  — same shape for all positions; masked at loss time
    """

    def __init__(self, l0_vocab_size: int, l1_vocab_size: int) -> None:
        super().__init__()
        self.l0_token_emb  = nn.Embedding(l0_vocab_size, D_MODEL, padding_idx=PAD_IDX)
        self.l1_token_emb  = nn.Embedding(l1_vocab_size, D_MODEL, padding_idx=PAD_IDX)
        self.pos_emb       = nn.Embedding(MAX_BUCKETS, D_MODEL)
        self.level_emb     = nn.Embedding(2, D_MODEL)   # 0=L0, 1=L1
        self.dropout       = nn.Dropout(DROPOUT)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=D_MODEL,
            nhead=N_HEADS,
            dim_feedforward=D_FF,
            dropout=DROPOUT,
            batch_first=True,
            norm_first=True,
        )
        self.encoder    = nn.TransformerEncoder(encoder_layer, num_layers=N_LAYERS)
        self.l0_head    = nn.Linear(D_MODEL, l0_vocab_size)
        self.l1_head    = nn.Linear(D_MODEL, l1_vocab_size)

        self._init_weights()

    def _init_weights(self) -> None:
        for emb in (self.l0_token_emb, self.l1_token_emb, self.pos_emb, self.level_emb):
            nn.init.normal_(emb.weight, std=0.02)
        nn.init.zeros_(self.l0_head.bias)
        nn.init.zeros_(self.l1_head.bias)

    def forward(
        self,
        token_ids:    torch.Tensor,  # (B, T) — L0 or L1 indices depending on level_ids
        bucket_idxs:  torch.Tensor,  # (B, T)
        level_ids:    torch.Tensor,  # (B, T) 0=L0 1=L1
        padding_mask: torch.Tensor,  # (B, T) bool
    ) -> tuple[torch.Tensor, torch.Tensor]:
        # Embed tokens by level
        l0_mask = level_ids == 0
        l1_mask = level_ids == 1
        tok_emb = torch.zeros(token_ids.shape[0], token_ids.shape[1], D_MODEL,
                               device=token_ids.device)
        if l0_mask.any():
            tok_emb[l0_mask] = self.l0_token_emb(token_ids[l0_mask])
        if l1_mask.any():
            tok_emb[l1_mask] = self.l1_token_emb(token_ids[l1_mask])

        x = tok_emb + self.pos_emb(bucket_idxs) + self.level_emb(level_ids)
        x = self.dropout(x)
        x = self.encoder(x, src_key_padding_mask=padding_mask)

        return self.l0_head(x), self.l1_head(x)  # (B,T,V_l0), (B,T,V_l1)
