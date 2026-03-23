"""
Qwen Labeler — assigns L0, L1, and L2 labels to events and content items.

Uses a two-stage inference strategy to prevent L0 anchoring bias:

  Stage 1 — L0 only: a short prompt with just the 8 class descriptions and
    the event/content title.  No existing vocab is shown, so the model cannot
    anchor on whichever L0 class has accumulated the most labels.

  Stage 2 — L1 (and L2 for content): given the locked L0, only the vocab for
    that specific L0 class is shown.  Cross-class noise is eliminated.

Single-item and batch paths both follow the two-stage flow; batch processing
issues two batch_generate calls (one per stage) so GPU utilisation is unchanged.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

from ci.tokenizer.vocab_registry import (
    L0_CLASSES,
    get_l1_vocab,
    get_l2_vocab,
    get_or_create_l1,
    get_or_create_l2,
    normalise_l0,
    write_content_label,
    write_event_label,
)

log = logging.getLogger(__name__)

_SYSTEM = (
    "You are a behavioral activity classifier. "
    "Respond with ONLY a valid JSON object — no explanation, no markdown, no extra text."
)

# Human-readable L0 descriptions used in every prompt so the model has
# semantic anchors when choosing between similar classes (e.g. SOCIAL vs LEISURE).
_L0_DESCRIPTIONS: dict[str, str] = {
    "WORK":     "professional tasks, meetings, projects, work calls",
    "EXERCISE": "physical fitness, sports, workouts, runs, gym",
    "SOCIAL":   "gatherings with people — friends, family, colleagues, dining out",
    "ERRAND":   "personal appointments, shopping, admin, chores, medical",
    "LEISURE":  "solo personal recreation, hobbies, entertainment, reading",
    "TRANSIT":  "travel, commuting, flights, drives, trips",
    "SLEEP":    "rest, sleep, naps",
    "UNKNOWN":  "cannot determine from the title",
}

_L0_BLOCK = "\n".join(
    f"  {cls:<10} — {desc}"
    for cls, desc in _L0_DESCRIPTIONS.items()
    if cls in set(L0_CLASSES)
)

# Maximum existing labels to include in the prompt (keeps prompt short)
_MAX_VOCAB_IN_PROMPT = 20


class QwenLabeler:
    """
    Labels events (L0+L1) and content items (L0+L1+L2) via an instruct LLM.

    Caches vocab lookups for the lifetime of the instance so batch labeling
    (e.g. a nightly run of 500 events) doesn't hit the DB per item.
    """

    def __init__(self) -> None:
        # Cache: (user_id, l0_class) → list[dict]
        self._l1_cache: dict[tuple[str, str], list[dict]] = {}
        # Cache: (user_id, l0_class, l1_cluster_id) → list[dict]
        self._l2_cache: dict[tuple[str, str, str], list[dict]] = {}

    # ── Public API ─────────────────────────────────────────────────────────────

    def label_event(
        self,
        event_id: str,
        user_id: str,
        title: str,
        description: Optional[str] = None,
    ) -> dict:
        """
        Assign L0 + L1 labels to a calendar event.

        Two inference calls: L0 first (no vocab), then L1 for the locked L0.
        Writes the result to hbpe.l1_event_cluster and returns:
          {"l0": str, "l1": str, "l1_id": str, "is_new_l1": bool}
        """
        from ci.inference.qwen import get_qwen

        title = (title or "(no title)")[:200]

        # Stage 1: L0
        l0_raw = get_qwen().generate(
            _build_l0_message(title, description),
            system_message=_SYSTEM,
            max_new_tokens=256,
        )
        l0 = normalise_l0(_parse_json(l0_raw).get("l0", "UNKNOWN"))

        # Stage 2: L1 given locked L0
        l1_vocab = self._all_l1_by_l0(user_id).get(l0, [])
        l1_raw_str = get_qwen().generate(
            _build_l1_event_message(title, description, l0, l1_vocab),
            system_message=_SYSTEM,
            max_new_tokens=256,
        )
        l1_raw = _clean_label(_parse_json(l1_raw_str).get("l1", "General"))

        l1_id, is_new_l1 = get_or_create_l1(user_id, l0, l1_raw)
        if is_new_l1:
            self._l1_cache.pop((user_id, l0), None)

        write_event_label(event_id, user_id, l0, l1_id)

        return {"l0": l0, "l1": l1_raw, "l1_id": l1_id, "is_new_l1": is_new_l1}

    def label_content(
        self,
        content_id: str,
        user_id: str,
        title: str,
        content_type: Optional[str] = None,
    ) -> dict:
        """
        Assign L0 + L1 + L2 labels to a content item (document, page, etc.).

        Two inference calls: L0 first, then L1+L2 for the locked L0.
        Writes to hbpe.l2_content_cluster + hbpe.content_context and returns:
          {"l0": str, "l1": str, "l1_id": str, "l2": str, "l2_id": str,
           "is_new_l1": bool, "is_new_l2": bool}
        """
        from ci.inference.qwen import get_qwen

        title = (title or "(no title)")[:200]

        # Stage 1: L0
        l0_raw = get_qwen().generate(
            _build_l0_message(title, None),
            system_message=_SYSTEM,
            max_new_tokens=256,
        )
        l0 = normalise_l0(_parse_json(l0_raw).get("l0", "UNKNOWN"))

        # Stage 2: L1 + L2 given locked L0
        all_l1 = self._all_l1_by_l0(user_id)
        all_l2 = self._all_l2_by_l1(user_id, all_l1)
        l1_vocab = all_l1.get(l0, [])
        l2_vocab = [e for entry in l1_vocab for e in all_l2.get(entry["cluster_id"], [])]

        l1l2_raw = get_qwen().generate(
            _build_l1_content_message(title, content_type, l0, l1_vocab, l2_vocab),
            system_message=_SYSTEM,
            max_new_tokens=256,
        )
        parsed = _parse_json(l1l2_raw)
        l1_raw = _clean_label(parsed.get("l1", "General"))
        l2_raw = _clean_label(parsed.get("l2", "General"))

        l1_id, is_new_l1 = get_or_create_l1(user_id, l0, l1_raw)
        l2_id, is_new_l2 = get_or_create_l2(user_id, l0, l1_id, l2_raw)

        if is_new_l1:
            self._l1_cache.pop((user_id, l0), None)
        if is_new_l2:
            self._l2_cache.pop((user_id, l0, l1_id), None)

        write_content_label(content_id, user_id, l0, l1_id, l2_id)

        return {
            "l0": l0,
            "l1": l1_raw, "l1_id": l1_id, "is_new_l1": is_new_l1,
            "l2": l2_raw, "l2_id": l2_id, "is_new_l2": is_new_l2,
        }

    def label_events_batch(
        self,
        items: list[dict],
        user_id: str,
    ) -> list[dict]:
        """
        Label a list of events using two batched forward passes.

        Stage 1: one batch_generate for all L0 classifications (no vocab shown).
        Stage 2: one batch_generate for all L1 labels (only the vocab for each
                 item's locked L0 is shown).

        Each item: {"event_id": str, "title": str, "description": str|None}
        Returns list of {"l0", "l1", "l1_id", "is_new_l1"} in same order.
        """
        from ci.inference.qwen import get_qwen

        if not items:
            return []

        titles = [(item.get("title") or "(no title)")[:200] for item in items]

        # Stage 1: L0 classification — no vocab, clean signal
        l0_prompts = [
            (_build_l0_message(title, item.get("description")), _SYSTEM)
            for title, item in zip(titles, items)
        ]
        l0_raws = get_qwen().batch_generate(l0_prompts, max_new_tokens=256)
        l0_results = [normalise_l0(_parse_json(raw).get("l0", "UNKNOWN")) for raw in l0_raws]

        # Stage 2: L1 given locked L0
        all_l1 = self._all_l1_by_l0(user_id)
        l1_prompts = [
            (_build_l1_event_message(title, item.get("description"), l0, all_l1.get(l0, [])), _SYSTEM)
            for title, item, l0 in zip(titles, items, l0_results)
        ]
        l1_raws = get_qwen().batch_generate(l1_prompts, max_new_tokens=256)

        results = []
        for item, l0, raw in zip(items, l0_results, l1_raws):
            l1_raw = _clean_label(_parse_json(raw).get("l1", "General"))
            l1_id, is_new_l1 = get_or_create_l1(user_id, l0, l1_raw)
            if is_new_l1:
                self._l1_cache.pop((user_id, l0), None)
            write_event_label(item["event_id"], user_id, l0, l1_id)
            results.append({"l0": l0, "l1": l1_raw, "l1_id": l1_id, "is_new_l1": is_new_l1})

        return results

    def label_content_batch(
        self,
        items: list[dict],
        user_id: str,
    ) -> list[dict]:
        """
        Label a list of content items using two batched forward passes.

        Stage 1: L0 for all items (no vocab).
        Stage 2: L1+L2 for all items using only the vocab for each item's locked L0.

        Each item: {"content_id": str, "title": str, "content_type": str|None}
        Returns list of {"l0", "l1", "l1_id", "l2", "l2_id", "is_new_l1", "is_new_l2"}.
        """
        from ci.inference.qwen import get_qwen

        if not items:
            return []

        titles = [(item.get("title") or "(no title)")[:200] for item in items]

        # Stage 1: L0 classification
        l0_prompts = [
            (_build_l0_message(title, None), _SYSTEM)
            for title in titles
        ]
        l0_raws = get_qwen().batch_generate(l0_prompts, max_new_tokens=256)
        l0_results = [normalise_l0(_parse_json(raw).get("l0", "UNKNOWN")) for raw in l0_raws]

        # Stage 2: L1 + L2 given locked L0
        all_l1 = self._all_l1_by_l0(user_id)
        all_l2 = self._all_l2_by_l1(user_id, all_l1)
        l1l2_prompts = [
            (_build_l1_content_message(
                title,
                item.get("content_type"),
                l0,
                all_l1.get(l0, []),
                [e for entry in all_l1.get(l0, []) for e in all_l2.get(entry["cluster_id"], [])],
            ), _SYSTEM)
            for title, item, l0 in zip(titles, items, l0_results)
        ]
        l1l2_raws = get_qwen().batch_generate(l1l2_prompts, max_new_tokens=256)

        results = []
        for item, l0, raw in zip(items, l0_results, l1l2_raws):
            parsed = _parse_json(raw)
            l1_raw = _clean_label(parsed.get("l1", "General"))
            l2_raw = _clean_label(parsed.get("l2", "General"))
            l1_id, is_new_l1 = get_or_create_l1(user_id, l0, l1_raw)
            l2_id, is_new_l2 = get_or_create_l2(user_id, l0, l1_id, l2_raw)
            if is_new_l1:
                self._l1_cache.pop((user_id, l0), None)
            if is_new_l2:
                self._l2_cache.pop((user_id, l0, l1_id), None)
            write_content_label(item["content_id"], user_id, l0, l1_id, l2_id)
            results.append({
                "l0": l0,
                "l1": l1_raw, "l1_id": l1_id, "is_new_l1": is_new_l1,
                "l2": l2_raw, "l2_id": l2_id, "is_new_l2": is_new_l2,
            })

        return results

    # ── Vocab helpers ──────────────────────────────────────────────────────────

    def _all_l1_by_l0(self, user_id: str) -> dict[str, list[dict]]:
        result: dict[str, list[dict]] = {}
        for l0 in L0_CLASSES:
            key = (user_id, l0)
            if key not in self._l1_cache:
                self._l1_cache[key] = get_l1_vocab(user_id, l0)
            result[l0] = self._l1_cache[key]
        return result

    def _all_l2_by_l1(
        self,
        user_id: str,
        all_l1: dict[str, list[dict]],
    ) -> dict[str, list[dict]]:
        result: dict[str, list[dict]] = {}
        for l0, l1_entries in all_l1.items():
            for entry in l1_entries:
                cid = entry["cluster_id"]
                key = (user_id, l0, cid)
                if key not in self._l2_cache:
                    self._l2_cache[key] = get_l2_vocab(user_id, l0, cid)
                result[cid] = self._l2_cache[key]
        return result


# ── Message builders ───────────────────────────────────────────────────────────

_L0_EXAMPLES = """\
Event: "Sprint planning meeting" → {"l0": "WORK"}
Event: "Architecture review" → {"l0": "WORK"}
Event: "Morning run" → {"l0": "EXERCISE"}
Event: "Strength training" → {"l0": "EXERCISE"}
Event: "Soccer" → {"l0": "EXERCISE"}
Event: "Dinner with friends" → {"l0": "SOCIAL"}
Event: "Family dinner" → {"l0": "SOCIAL"}
Event: "Grocery shopping" → {"l0": "ERRAND"}
Event: "Grocery run" → {"l0": "ERRAND"}
Event: "Home maintenance" → {"l0": "ERRAND"}
Event: "Shop" → {"l0": "ERRAND"}
Event: "Read a book" → {"l0": "LEISURE"}
Event: "Books" → {"l0": "LEISURE"}
Event: "Flight to NYC" → {"l0": "TRANSIT"}
Event: "Sleep" → {"l0": "SLEEP"}"""


def _build_l0_message(title: str, description: Optional[str]) -> str:
    """Stage 1: classify L0 only. Few-shot examples anchor the model to diverse classes."""
    desc_line = f"\nDescription: {description}" if description else ""
    return (
        f"Classify the activity category of this calendar event.\n\n"
        f"Categories:\n{_L0_BLOCK}\n\n"
        f"Examples:\n{_L0_EXAMPLES}\n\n"
        f"Event: \"{title}\"{desc_line} → "
    )


def _build_l1_event_message(
    title: str,
    description: Optional[str],
    l0: str,
    l1_vocab: list[dict],
) -> str:
    """Stage 2 for events: assign L1 sub-category given locked L0."""
    labels = [e["label"] for e in l1_vocab[:_MAX_VOCAB_IN_PROMPT]]
    vocab_str = f"[{', '.join(repr(l) for l in labels)}]" if labels else "(none yet — propose one)"
    desc_line = f"\nDescription: {description}" if description else ""
    return (
        f"Assign a sub-category label for this {l0} calendar event.\n\n"
        f"Existing {l0} sub-categories: {vocab_str}\n\n"
        f"Use an existing label if it fits, or propose a concise 1-3 word label.\n\n"
        f"Event: \"{title}\"{desc_line}\n\n"
        f'Output: {{"l1": "LABEL"}}'
    )


def _build_l1_content_message(
    title: str,
    content_type: Optional[str],
    l0: str,
    l1_vocab: list[dict],
    l2_vocab: list[dict],
) -> str:
    """Stage 2 for content: assign L1+L2 given locked L0."""
    l1_labels = [e["label"] for e in l1_vocab[:_MAX_VOCAB_IN_PROMPT]]
    l1_str = f"[{', '.join(repr(l) for l in l1_labels)}]" if l1_labels else "(none yet — propose one)"
    l2_labels = list({e["label"] for e in l2_vocab})[:_MAX_VOCAB_IN_PROMPT]
    l2_str = f"[{', '.join(repr(l) for l in l2_labels)}]" if l2_labels else "(none yet — propose one)"
    type_line = f" ({content_type})" if content_type else ""
    return (
        f"Assign sub-category and topic labels for this {l0} content item.\n\n"
        f"Existing {l0} sub-categories (L1): {l1_str}\n"
        f"Existing topic labels (L2): {l2_str}\n\n"
        f"Use existing labels if they fit, or propose concise 1-3 word labels.\n\n"
        f"Content: \"{title}\"{type_line}\n\n"
        f'Output: {{"l1": "LABEL", "l2": "LABEL"}}'
    )


# ── JSON parsing ───────────────────────────────────────────────────────────────


def _parse_json(raw: str) -> dict:
    """
    Extract a JSON object from the model's response.

    Finds the first `{` in the output and extracts through the matching `}`.
    Falls back to regex field extraction on malformed output.
    """
    start = raw.find("{")
    if start == -1:
        return _regex_fallback(raw)

    brace_depth = 0
    end = start
    for i in range(start, len(raw)):
        if raw[i] == "{":
            brace_depth += 1
        elif raw[i] == "}":
            brace_depth -= 1
            if brace_depth == 0:
                end = i + 1
                break

    try:
        return json.loads(raw[start:end])
    except (json.JSONDecodeError, ValueError):
        return _regex_fallback(raw)


def _regex_fallback(raw: str) -> dict:
    result = {}
    for key in ("l0", "l1", "l2"):
        m = re.search(rf'"{key}"\s*:\s*"([^"]+)"', raw)
        if m:
            result[key] = m.group(1)
    return result


def _clean_label(raw: str) -> str:
    cleaned = raw.strip().strip("\"'").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:50] if cleaned else "General"
