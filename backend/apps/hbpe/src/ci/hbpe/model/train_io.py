"""
Crash-safe IO and reproducibility helpers for HBPE training.

Everything here is import-safe without torch, so the contracts can be tested
on a machine that has no training stack. torch is imported lazily and only by
the helpers that need it.

Why this exists (see plans/hbpe-review.md, findings F1 to F9):
  * torch.save went straight to the live checkpoint path, so a crash or a
    cancelled nightly could corrupt the only copy.
  * The nightly adapter overwrote itself forever, with no history to roll back.
  * Nothing was seeded, so a failed run could not be replayed.
  * Device selection was copy-pasted in three places.
"""

from __future__ import annotations

import contextlib
import hashlib
import math
import os
import random
import re
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

DEFAULT_SEED = 1337
ADAPTER_KEEP = 3


class AdapterMismatch(ValueError):
    """The adapter on disk was not trained against the model being loaded."""


# ── Atomic writes ─────────────────────────────────────────────────────────────


def atomic_write(path: str | Path, writer: Callable[[Path], None]) -> Path:
    """Run ``writer(tmp_path)``, then atomically move the result onto *path*.

    The temp file lives in the destination directory so ``os.replace`` stays on
    one filesystem. If the writer raises, *path* is left exactly as it was and
    the temp file is removed.
    """
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=dest.parent, prefix=f".{dest.name}.", suffix=".tmp"
    )
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        writer(tmp)
        with open(tmp, "rb") as fh:
            os.fsync(fh.fileno())
        os.replace(tmp, dest)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        raise
    return dest


def atomic_torch_save(obj: Any, path: str | Path) -> Path:
    import torch

    return atomic_write(path, lambda tmp: torch.save(obj, tmp))


def atomic_write_text(path: str | Path, text: str) -> Path:
    return atomic_write(path, lambda tmp: tmp.write_text(text, encoding="utf-8"))


# ── Versioned artifacts (rollback for the nightly adapter) ────────────────────

_VERSION_RE = re.compile(r"\.v(\d{4})$")


def list_versions(path: str | Path) -> list[Path]:
    """Archived copies of *path*, oldest first."""
    dest = Path(path)
    if not dest.parent.exists():
        return []
    found: list[tuple[int, Path]] = []
    for p in dest.parent.glob(f"{dest.name}.v*"):
        m = _VERSION_RE.search(p.name)
        if m and p.name[: m.start()] == dest.name:
            found.append((int(m.group(1)), p))
    return [p for _, p in sorted(found)]


def archive_previous(path: str | Path, keep: int = ADAPTER_KEEP) -> Path | None:
    """Copy the current *path* to ``<name>.vNNNN`` and prune old copies.

    Returns the archive path, or None when there was nothing to archive.
    """
    dest = Path(path)
    if not dest.exists():
        return None
    versions = list_versions(dest)
    next_n = 1
    if versions:
        m = _VERSION_RE.search(versions[-1].name)
        next_n = int(m.group(1)) + 1 if m else len(versions) + 1
    archived = dest.with_name(f"{dest.name}.v{next_n:04d}")
    shutil.copy2(dest, archived)
    for old in list_versions(dest)[: max(len(list_versions(dest)) - keep, 0)]:
        with contextlib.suppress(FileNotFoundError):
            old.unlink()
    return archived


def restore_previous(path: str | Path) -> Path | None:
    """Put the newest archived copy back as *path*. Returns it, or None."""
    dest = Path(path)
    versions = list_versions(dest)
    if not versions:
        return None
    newest = versions[-1]
    atomic_write(dest, lambda tmp: shutil.copyfile(newest, tmp))
    return newest


# ── Adapter compatibility ─────────────────────────────────────────────────────


def file_digest(path: str | Path, *, length: int = 16) -> str | None:
    """Short sha256 of a file, or None when it does not exist."""
    p = Path(path)
    if not p.exists():
        return None
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:length]


def adapter_meta(
    *,
    architecture: str | None,
    l1_vocab_fingerprint: str | None,
    base_digest: str | None,
) -> dict[str, str]:
    """Identity of the base model an adapter was trained against."""
    meta = {
        "architecture": architecture,
        "l1_vocab_fingerprint": l1_vocab_fingerprint,
        "base_digest": base_digest,
    }
    return {k: v for k, v in meta.items() if v is not None}


def check_adapter_meta(
    saved: dict[str, str] | None,
    *,
    architecture: str | None = None,
    l1_vocab_fingerprint: str | None = None,
    base_digest: str | None = None,
) -> None:
    """Raise AdapterMismatch if *saved* names a different base than expected.

    A legacy adapter with no meta passes: there is nothing to compare, and the
    caller decides whether that is acceptable. A field that is absent on either
    side is not compared.
    """
    if not saved:
        return
    expected = {
        "architecture": architecture,
        "l1_vocab_fingerprint": l1_vocab_fingerprint,
        "base_digest": base_digest,
    }
    for key, want in expected.items():
        have = saved.get(key)
        if want is not None and have is not None and have != want:
            raise AdapterMismatch(f"adapter {key} {have!r} does not match {want!r}")


# ── Reproducibility, devices, loss bookkeeping ────────────────────────────────


def seed_everything(seed: int | None = None) -> int:
    """Seed python, numpy and torch (when present). Returns the seed used."""
    if seed is None:
        seed = int(os.getenv("HBPE_TRAIN_SEED", str(DEFAULT_SEED)))
    random.seed(seed)
    with contextlib.suppress(ImportError):
        import numpy as np

        np.random.seed(seed % (2**32))
    with contextlib.suppress(ImportError):
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    return seed


def resolve_device(requested: str | None = None) -> str:
    """cuda, then mps, then cpu, unless the caller named one."""
    if requested:
        return requested
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def mean_step_loss(total_loss: float, steps: int) -> float | None:
    """Mean of per-step losses. None when no step ran.

    Each step's loss is already a mean over its tokens, so the correct divisor
    is the number of steps. The nightly job used to divide by the token count,
    which made the logged loss meaningless.
    """
    if steps <= 0:
        return None
    return total_loss / steps


def select_monitor_loss(
    train_loss: float, val_loss: float, n_val_days: int
) -> tuple[float, str]:
    """Pick the loss early stopping watches.

    With no validation days the epoch loop reports a validation loss of 0.0,
    which "improves" on epoch 1 and then never again, so training silently
    stops after the patience window with a one-epoch model. Fall back to the
    train loss in that case and say which one is being watched.
    """
    if n_val_days <= 0:
        return train_loss, "train"
    return val_loss, "val"


def is_finite(x: float | None) -> bool:
    return x is not None and math.isfinite(x)
