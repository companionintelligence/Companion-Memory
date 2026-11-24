"""Golden-conversation cases for the multi-turn chat eval.

A case is one conversation plus the behavior each turn should show. The
expected block names tools and facts. It does not collapse those into one
score. Personal cases (facts from a real memory) stay outside the git tree;
the cases committed here are self-contained.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Family names expand to the tool names the chat agent actually exposes.
# A case can name a family ("places") or an exact tool ("places.find").
TOOL_FAMILIES: dict[str, frozenset[str]] = {
    "memory": frozenset(
        {
            "knowledge.search",
            "memory.recall",
            "memory.remember",
            "memory.forget",
            "knowledge.preferences",
        }
    ),
    "graph": frozenset({"people.find", "people.relationships"}),
    "places": frozenset({"places.find", "places.next"}),
    "calendar": frozenset({"calendar.findEvents"}),
    "media": frozenset(
        {
            "media.findPhotos",
            "media.entertainmentPreferences",
            "media.streamingAvailability",
        }
    ),
    "messaging": frozenset(
        {"messaging.listMessages", "messaging.listChats", "messaging.send"}
    ),
    "planning": frozenset(
        {
            "planning.findTasks",
            "planning.createTask",
            "planning.updateTask",
            "planning.completeTask",
            "planning.scheduleTask",
            "planning.plannedBlocks",
        }
    ),
    "forecast": frozenset({"forecast.read", "forecast.calibration"}),
    "import": frozenset(
        {
            "import.import_path",
            "import.recognize_path",
            "import.scan_inbox",
            "import.import_inbox",
            "import.run_status",
            "import.list_sources",
        }
    ),
}

CAPABILITIES = (
    "memory",
    "graph",
    "ontology",
    "tools",
    "conversation",
    "robustness",
)


@dataclass
class Expected:
    """Checks for one turn. Empty lists mean "this check is not in the case"."""

    should_use: list[str] = field(default_factory=list)
    # At least one of these specs must match. Use this when either tool is right.
    should_use_any: list[str] = field(default_factory=list)
    must_not_use: list[str] = field(default_factory=list)
    answer_contains: list[str] = field(default_factory=list)
    # At least one phrase must appear. Natural answers rarely share one wording.
    answer_contains_any: list[str] = field(default_factory=list)
    answer_must_not_contain: list[str] = field(default_factory=list)
    # Substrings that must appear in the JSON arguments of a matching call.
    argument_contains: dict[str, list[str]] = field(default_factory=dict)
    admit_unknown: bool = False

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> Expected:
        raw = raw or {}
        args = raw.get("argument_contains") or {}
        if not isinstance(args, dict):
            args = {}
        return cls(
            should_use=_str_list(raw.get("should_use")),
            should_use_any=_str_list(raw.get("should_use_any")),
            must_not_use=_str_list(raw.get("must_not_use")),
            answer_contains=_str_list(raw.get("answer_contains")),
            answer_contains_any=_str_list(raw.get("answer_contains_any")),
            answer_must_not_contain=_str_list(raw.get("answer_must_not_contain")),
            argument_contains={str(k): _str_list(v) for k, v in args.items()},
            admit_unknown=bool(raw.get("admit_unknown", False)),
        )

    def is_empty(self) -> bool:
        return not (
            self.should_use
            or self.should_use_any
            or self.must_not_use
            or self.answer_contains
            or self.answer_contains_any
            or self.answer_must_not_contain
            or self.argument_contains
            or self.admit_unknown
        )


@dataclass
class Turn:
    role: str
    content: str
    expected: Expected = field(default_factory=Expected)


@dataclass
class Case:
    id: str
    capability: str
    conversation: list[Turn]
    title: str = ""
    # Tools that must appear on some turn, not necessarily the last one.
    anywhere_should_use: list[str] = field(default_factory=list)
    anywhere_should_use_any: list[str] = field(default_factory=list)
    # Owner has not filled the answer key yet. The runner skips the case
    # unless asked to score incomplete cases.
    needs_owner: bool = False
    source: str = ""

    @classmethod
    def from_dict(cls, raw: dict[str, Any], source: str = "") -> Case:
        turns_expected = raw.get("turns") or []
        conversation: list[Turn] = []
        for i, message in enumerate(raw.get("conversation") or []):
            per_turn = {}
            if i < len(turns_expected) and isinstance(turns_expected[i], dict):
                per_turn = turns_expected[i]
            conversation.append(
                Turn(
                    role=str(message.get("role", "")),
                    content=str(message.get("content", "")),
                    expected=Expected.from_dict(per_turn),
                )
            )
        # A case-level expected applies to the final turn when that turn
        # has no expected of its own.
        final = Expected.from_dict(raw.get("expected"))
        if (
            conversation
            and conversation[-1].expected.is_empty()
            and not final.is_empty()
        ):
            conversation[-1].expected = final
        anywhere = raw.get("anywhere") or {}
        return cls(
            id=str(raw.get("id", "")),
            capability=str(raw.get("capability", "")),
            title=str(raw.get("title", "")),
            conversation=conversation,
            anywhere_should_use=_str_list(anywhere.get("should_use")),
            anywhere_should_use_any=_str_list(anywhere.get("should_use_any")),
            needs_owner=bool(raw.get("needs_owner", False)),
            source=source,
        )


def validate_case(raw: Any) -> list[str]:
    """Human-readable errors. Empty means the case can run."""
    errors: list[str] = []
    if not isinstance(raw, dict):
        return ["case must be a JSON object"]
    if not isinstance(raw.get("id"), str) or not raw["id"].strip():
        errors.append("id must be a non-empty string")
    capability = raw.get("capability")
    if capability not in CAPABILITIES:
        errors.append(
            f"capability must be one of {', '.join(CAPABILITIES)} (got {capability!r})"
        )
    conversation = raw.get("conversation")
    if not isinstance(conversation, list) or not conversation:
        errors.append("conversation must be a non-empty list")
    else:
        for i, message in enumerate(conversation):
            if not isinstance(message, dict):
                errors.append(f"conversation[{i}] must be an object")
                continue
            if message.get("role") != "user":
                errors.append(
                    f"conversation[{i}].role must be 'user' "
                    "(the runner supplies the assistant turns)"
                )
            if (
                not isinstance(message.get("content"), str)
                or not message["content"].strip()
            ):
                errors.append(f"conversation[{i}].content must be a non-empty string")
    turns = raw.get("turns")
    if turns is not None:
        if not isinstance(turns, list):
            errors.append("turns must be a list")
        elif isinstance(conversation, list) and len(turns) > len(conversation):
            errors.append("turns is longer than conversation")
    _check_tool_specs(errors, raw.get("expected") or {}, "expected")
    if isinstance(turns, list):
        for i, turn in enumerate(turns):
            if isinstance(turn, dict):
                _check_tool_specs(errors, turn, f"turns[{i}]")
    anywhere = raw.get("anywhere") or {}
    if isinstance(anywhere, dict):
        _check_tool_specs(errors, anywhere, "anywhere")
    return errors


def load_cases(directory: Path) -> tuple[list[Case], list[str]]:
    """Load every *.json under directory. Returns cases and error strings."""
    cases: list[Case] = []
    errors: list[str] = []
    if not directory.is_dir():
        return cases, [f"not a directory: {directory}"]
    for path in sorted(directory.rglob("*.json")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{path}: {exc}")
            continue
        found = validate_case(raw)
        if found:
            errors.extend(f"{path}: {item}" for item in found)
            continue
        cases.append(Case.from_dict(raw, source=str(path)))
    return cases, errors


def expand_spec(spec: str) -> frozenset[str]:
    """A family name expands to its tools. An exact name stays itself."""
    if spec in TOOL_FAMILIES:
        return TOOL_FAMILIES[spec]
    return frozenset({spec})


def _check_tool_specs(errors: list[str], block: dict[str, Any], where: str) -> None:
    for key in ("should_use", "should_use_any", "must_not_use"):
        values = block.get(key)
        if values is None:
            continue
        if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
            errors.append(f"{where}.{key} must be a list of strings")


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str)]
