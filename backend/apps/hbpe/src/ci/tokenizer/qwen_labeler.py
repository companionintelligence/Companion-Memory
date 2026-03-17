"""
Qwen Labeler — assigns L0, L1, and L2 labels to events and content items
using a single chat-style prompt per item.

Uses an instruct model (default: Qwen/Qwen2.5-1.5B-Instruct) with a
system + user message so the model reliably follows JSON format instructions.

Label format:
  - L0: one of the 8 fixed classes (WORK, EXERCISE, SOCIAL, ...)
  - L1: a 2-4 word sub-category string (e.g. "Engineering Meetings")
  - L2: a 2-4 word topic string (e.g. "Sprint Planning") — content only

Prompt strategy: chat messages with a system instruction that mandates JSON
output, plus a user message listing the L0 options and existing vocab.
`_parse_json` finds the first `{...}` block in the response (handles any
preamble the model adds before the JSON).
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

        Writes the result to ci.l1_event_cluster and returns:
          {"l0": str, "l1": str, "l1_id": str, "is_new_l1": bool}
        """
        from ci.inference.qwen import get_qwen

        all_l1 = self._all_l1_by_l0(user_id)
        user_msg = _build_event_user_message(title, description, all_l1)

        raw = get_qwen().generate(user_msg, system_message=_SYSTEM, max_new_tokens=60)
        parsed = _parse_json(raw)

        l0 = normalise_l0(parsed.get("l0", "UNKNOWN"))
        l1_raw = _clean_label(parsed.get("l1", "General"))

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

        Writes to ci.l2_content_cluster + ci.content_context and returns:
          {"l0": str, "l1": str, "l1_id": str, "l2": str, "l2_id": str,
           "is_new_l1": bool, "is_new_l2": bool}
        """
        from ci.inference.qwen import get_qwen

        all_l1 = self._all_l1_by_l0(user_id)
        all_l2 = self._all_l2_by_l1(user_id, all_l1)
        user_msg = _build_content_user_message(title, content_type, all_l1, all_l2)

        raw = get_qwen().generate(user_msg, system_message=_SYSTEM, max_new_tokens=80)
        parsed = _parse_json(raw)

        l0 = normalise_l0(parsed.get("l0", "UNKNOWN"))
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


def _build_event_user_message(
    title: str,
    description: Optional[str],
    all_l1: dict[str, list[dict]],
) -> str:
    vocab_lines = _format_l1_vocab(all_l1)
    desc_line = f"\nDescription: {description}" if description else ""

    return (
        f"Classify this calendar event.\n\n"
        f"L0 — choose EXACTLY one of these classes (use the exact name):\n{_L0_BLOCK}\n\n"
        f"L1 — activity sub-category. Choose from the existing labels below, "
        f"or propose a new concise 2-4 word label:\n{vocab_lines}\n\n"
        f"Event: \"{title}\"{desc_line}\n\n"
        f'Output format: {{"l0": "...", "l1": "..."}}'
    )


def _build_content_user_message(
    title: str,
    content_type: Optional[str],
    all_l1: dict[str, list[dict]],
    all_l2: dict[str, list[dict]],
) -> str:
    vocab_lines = _format_l1_vocab(all_l1)
    l2_lines = _format_l2_vocab(all_l2)
    type_line = f" ({content_type})" if content_type else ""

    return (
        f"Classify this content item.\n\n"
        f"L0 — choose EXACTLY one of these classes (use the exact name):\n{_L0_BLOCK}\n\n"
        f"L1 — activity sub-category (choose from list or propose new 2-4 word label):\n"
        f"{vocab_lines}\n\n"
        f"L2 — specific topic (choose from list or propose new 2-4 word label):\n"
        f"{l2_lines}\n\n"
        f"Content: \"{title}\"{type_line}\n\n"
        f'Output format: {{"l0": "...", "l1": "...", "l2": "..."}}'
    )


def _format_l1_vocab(all_l1: dict[str, list[dict]]) -> str:
    lines = []
    for l0 in L0_CLASSES:
        entries = all_l1.get(l0, [])[:_MAX_VOCAB_IN_PROMPT]
        labels = [e["label"] for e in entries]
        if labels:
            lines.append(f'  {l0}: [{", ".join(repr(l) for l in labels)}]')
        else:
            lines.append(f"  {l0}: (none yet — propose one)")
    return "\n".join(lines)


def _format_l2_vocab(all_l2: dict[str, list[dict]]) -> str:
    seen: set[str] = set()
    labels: list[str] = []
    for entries in all_l2.values():
        for e in entries[:_MAX_VOCAB_IN_PROMPT]:
            lbl = e["label"]
            if lbl not in seen:
                seen.add(lbl)
                labels.append(lbl)
    if not labels:
        return "  (none yet — propose one)"
    return "  " + ", ".join(repr(l) for l in labels[:_MAX_VOCAB_IN_PROMPT])


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
