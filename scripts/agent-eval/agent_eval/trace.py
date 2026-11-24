"""A conversation trace is the unit this eval scores.

Messages come back from the chat API as user, assistant, and tool rows.
This module folds one thread into turns: each user message, the tool calls
that followed it, and the assistant text that closed the turn.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolCall:
    name: str
    arguments: dict[str, Any]
    result: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "arguments": self.arguments, "result": self.result}


@dataclass
class TurnTrace:
    user: str
    assistant_text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    # How many tool-result rows came back. Compared with calls so a dropped
    # result is visible separately from a wrong answer.
    tool_results: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "user": self.user,
            "assistant_text": self.assistant_text,
            "tool_calls": [call.to_dict() for call in self.tool_calls],
            "tool_results": self.tool_results,
        }


@dataclass
class ConversationTrace:
    case_id: str
    thread_id: str
    turns: list[TurnTrace] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "thread_id": self.thread_id,
            "error": self.error,
            "turns": [turn.to_dict() for turn in self.turns],
        }


def messages_to_trace(
    case_id: str, thread_id: str, messages: list[dict[str, Any]]
) -> ConversationTrace:
    """Fold API messages into turns. Order is createdAt, then original index."""
    ordered = sorted(
        enumerate(messages),
        key=lambda pair: (str(pair[1].get("createdAt") or ""), pair[0]),
    )
    turns: list[TurnTrace] = []
    current: TurnTrace | None = None
    pending_calls: list[ToolCall] = []

    for _, message in ordered:
        role = message.get("role")
        content = message.get("content") or ""
        if not isinstance(content, str):
            content = str(content)
        if role == "user":
            if current is not None:
                current.tool_calls.extend(pending_calls)
                turns.append(current)
            pending_calls = []
            current = TurnTrace(user=content, assistant_text="")
            continue
        if current is None:
            continue
        if role == "assistant":
            text = _visible_text(content)
            if text:
                current.assistant_text = (
                    f"{current.assistant_text}\n{text}".strip()
                    if current.assistant_text
                    else text
                )
            for call in message.get("toolCalls") or []:
                if isinstance(call, dict):
                    pending_calls.append(_call_from_message(call))
        elif role == "tool":
            current.tool_results += 1
            if pending_calls and not pending_calls[-1].result:
                pending_calls[-1].result = content
            elif pending_calls:
                # Extra results attach to the last call rather than being dropped.
                pending_calls[-1].result = (
                    pending_calls[-1].result + "\n" + content
                ).strip()

    if current is not None:
        current.tool_calls.extend(pending_calls)
        turns.append(current)
    return ConversationTrace(case_id=case_id, thread_id=thread_id, turns=turns)


def _visible_text(content: str) -> str:
    """Drop <think> blocks. Tool chips are not stored in content."""
    text = content
    while "<think>" in text and "</think>" in text:
        start = text.find("<think>")
        end = text.find("</think>", start)
        if end < 0:
            break
        text = text[:start] + text[end + len("</think>") :]
    return text.strip()


def _call_from_message(call: dict[str, Any]) -> ToolCall:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(function.get("name") or call.get("name") or "")
    raw_args = function.get("arguments", call.get("arguments", {}))
    return ToolCall(name=name, arguments=_arguments(raw_args))


def _arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"_raw": raw}
        if isinstance(parsed, dict):
            return parsed
    return {}
