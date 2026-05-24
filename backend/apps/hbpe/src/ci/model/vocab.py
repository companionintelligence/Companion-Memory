"""
Vocab registry — maps token_id strings to integer indices for the HMT model.

L0 vocabulary is fixed (8 behavioral classes + SOD + EOD + MASK = 11 tokens).
L1/L2 vocabularies are dynamic: queried from ci.l1_clusters / ci.l2_clusters
and rebuilt whenever new clusters are discovered.

Implements T2.1 (CI-Server-oj3).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from ci.database import get_conn
from ci.tokenizer.vocab_registry import L0_CLASSES

log = logging.getLogger(__name__)

# Special tokens shared across all levels
PAD_TOKEN   = "<PAD>"
MASK_TOKEN  = "<MASK>"
SOD_TOKEN   = "SOD"
EOD_TOKEN   = "EOD"

_SPECIAL = [PAD_TOKEN, MASK_TOKEN, SOD_TOKEN, EOD_TOKEN]

PAD_IDX  = 0
MASK_IDX = 1
SOD_IDX  = 2
EOD_IDX  = 3


@dataclass
class Vocab:
    """Maps token_id strings ↔ integer indices for one hierarchy level."""
    token_to_idx: dict[str, int] = field(default_factory=dict)
    idx_to_token: list[str]      = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.idx_to_token)

    def encode(self, token_id: str) -> int:
        return self.token_to_idx.get(token_id, PAD_IDX)

    def decode(self, idx: int) -> str:
        return self.idx_to_token[idx] if idx < len(self.idx_to_token) else PAD_TOKEN


def build_l0_vocab() -> Vocab:
    """
    Build the fixed L0 vocabulary.

    Index layout:
      0  <PAD>
      1  <MASK>
      2  SOD
      3  EOD
      4..11  L0_CLASSES (WORK, EXERCISE, SOCIAL, ERRAND, LEISURE, TRANSIT, SLEEP, UNKNOWN)
    """
    tokens = _SPECIAL + list(L0_CLASSES)
    return _make_vocab(tokens)


def build_l1_vocab(user_id: str) -> Vocab:
    """
    Build the L1 vocabulary from active clusters in ci.l1_clusters.

    Indices 0-3 are the shared special tokens; cluster UUIDs follow.
    """
    sql = """
        SELECT cluster_id::text
        FROM hbpe.l1_clusters
        WHERE user_id = %s AND is_active = TRUE
        ORDER BY l0_class, created_at
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (user_id,))
            cluster_ids = [row[0] for row in cur.fetchall()]

    tokens = _SPECIAL + cluster_ids
    log.info("Built L1 vocab: %d clusters", len(cluster_ids))
    return _make_vocab(tokens)



def _make_vocab(tokens: list[str]) -> Vocab:
    token_to_idx = {t: i for i, t in enumerate(tokens)}
    return Vocab(token_to_idx=token_to_idx, idx_to_token=tokens)
