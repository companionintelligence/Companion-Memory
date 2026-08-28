"""Persistent verdict cache for the LLM judge.

LLM-judge runs are slow (each verdict is a chat-completions round trip) and
token-priced, but verdicts depend only on ``(question, gold answer, retrieved
context, judge model)``. So they cache perfectly across re-runs: the second time
you score the same context with the same model, the cached verdict applies.

Layout: one JSON file, one entry per ``(model, question_id, gold, context-hash)``
key. Atomic save (write to ``.tmp`` then rename) so a SIGINT mid-run can't
corrupt the cache.

Used through :func:`cached_scorer`, which wraps any underlying scorer and
short-circuits on hit:

    from benchmark.judge_cache import JudgeCache, cached_scorer
    from benchmark.scoring import make_llm_scorer

    cache = JudgeCache.load("judge_cache.json")
    inner = make_llm_scorer(...)
    scorer = cached_scorer(inner, cache, model="qwen2.5-7b")
    # ... run benchmark ...
    cache.save()
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

from .schema import EvalQuestion
from .scoring import Scorer


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _key(model: str, question: EvalQuestion, context: str) -> str:
    """Stable cache key. Gold answer is included so a persona edit invalidates."""
    gold = question.answer or ",".join(question.keywords)
    return ":".join([model, question.id, _hash(gold), _hash(context)])


@dataclass
class JudgeCache:
    """In-memory verdict cache with atomic JSON persistence."""

    entries: Dict[str, Tuple[bool, str]] = field(default_factory=dict)
    path: Optional[Path] = None
    hits: int = 0
    misses: int = 0

    # ── load / save ──────────────────────────────────────────────────────────

    @classmethod
    def load(cls, path: str | os.PathLike) -> "JudgeCache":
        """Load from ``path`` if it exists; otherwise return an empty cache."""
        p = Path(path)
        if not p.exists():
            return cls(path=p)
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # Corrupt or unreadable — start fresh rather than crash a run that
            # only wanted the cache as a speed-up.
            return cls(path=p)
        entries: Dict[str, Tuple[bool, str]] = {}
        for k, v in (raw.get("entries") or {}).items():
            try:
                entries[k] = (bool(v["correct"]), str(v.get("reason", "")))
            except (KeyError, TypeError):
                continue
        return cls(entries=entries, path=p)

    def save(self, path: str | os.PathLike | None = None) -> None:
        """Atomically write the cache to disk."""
        target = Path(path) if path is not None else self.path
        if target is None:
            return
        payload = {
            "version": 1,
            "entries": {k: {"correct": ok, "reason": reason} for k, (ok, reason) in self.entries.items()},
        }
        # Write to a sibling .tmp, then rename — atomic on POSIX.
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=target.name + ".", dir=str(target.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2)
            os.replace(tmp, target)
        except Exception:
            # If anything went wrong, clean up the .tmp and re-raise.
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self.path = target

    # ── lookup / write ───────────────────────────────────────────────────────

    def get(self, model: str, question: EvalQuestion, context: str) -> Optional[Tuple[bool, str]]:
        return self.entries.get(_key(model, question, context))

    def put(self, model: str, question: EvalQuestion, context: str, verdict: Tuple[bool, str]) -> None:
        self.entries[_key(model, question, context)] = (bool(verdict[0]), str(verdict[1]))

    def __len__(self) -> int:
        return len(self.entries)


# ---------------------------------------------------------------------------
# Scorer wrapper
# ---------------------------------------------------------------------------


def cached_scorer(inner: Scorer, cache: JudgeCache, *, model: str) -> Scorer:
    """Wrap a scorer to short-circuit on cache hit; record hit/miss counts."""

    def scored(question: EvalQuestion, context: str) -> Tuple[bool, str]:
        cached = cache.get(model, question, context)
        if cached is not None:
            cache.hits += 1
            return cached
        cache.misses += 1
        verdict = inner(question, context)
        cache.put(model, question, context, verdict)
        return verdict

    return scored
