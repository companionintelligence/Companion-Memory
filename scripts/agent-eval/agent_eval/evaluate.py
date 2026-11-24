"""Deterministic checks over a trace.

Each check names its own metric. Callers report those metrics separately.
An LLM judge is intentionally not in this module: anything that can be
decided from the tool name, the arguments, or a required phrase is decided
here.
"""

from __future__ import annotations

from dataclasses import dataclass

from .schema import Case, Expected, expand_spec
from .trace import ConversationTrace, TurnTrace

# Phrases that count as admitting the memory does not contain the fact.
# Matching is case-insensitive and only used when the case sets admit_unknown.
_UNKNOWN_PHRASES = (
    "don't have",
    "do not have",
    "don't know",
    "do not know",
    "no record",
    "not in your",
    "couldn't find",
    "could not find",
    "nothing in",
    "no memory",
    "not seeing",
    "i don't see",
    "don't see",
    "no information",
    "not something i have",
    "isn't in",
    "is not in",
    "not yet have",
    "do not yet have",
)


def _fold(text: str) -> str:
    """Lowercase, and treat curly apostrophes as straight ones."""
    return text.lower().replace("\u2019", "'").replace("\u2018", "'").replace("`", "'")


def _same_tool(actual: str, allowed: frozenset[str]) -> bool:
    """memory_recall in a saved trace is the same tool as memory.recall."""
    key = actual.lower().replace("_", ".")
    return any(key == item.lower().replace("_", ".") for item in allowed)


@dataclass
class Check:
    metric: str
    passed: bool
    detail: str
    turn_index: int | None = None

    def to_dict(self) -> dict:
        return {
            "metric": self.metric,
            "passed": self.passed,
            "detail": self.detail,
            "turn_index": self.turn_index,
        }


def evaluate_trace(case: Case, trace: ConversationTrace) -> list[Check]:
    """Score one trace. A transport error fails the run metric and stops."""
    if trace.error:
        return [
            Check(
                metric="run",
                passed=False,
                detail=trace.error,
            )
        ]
    checks: list[Check] = []
    if len(trace.turns) != len(case.conversation):
        checks.append(
            Check(
                metric="run",
                passed=False,
                detail=(
                    f"expected {len(case.conversation)} turns, "
                    f"trace has {len(trace.turns)}"
                ),
            )
        )
    for index, turn_case in enumerate(case.conversation):
        if turn_case.expected.is_empty():
            continue
        if index >= len(trace.turns):
            checks.append(
                Check(
                    metric="run",
                    passed=False,
                    detail=f"turn {index + 1} was not produced",
                    turn_index=index,
                )
            )
            continue
        checks.extend(_evaluate_turn(index, turn_case.expected, trace.turns[index]))
    if case.anywhere_should_use or case.anywhere_should_use_any:
        names = [call.name for turn in trace.turns for call in turn.tool_calls]
        checks.extend(
            _should_use(
                case.anywhere_should_use,
                names,
                turn_index=None,
                metric="tool_selection",
            )
        )
        checks.extend(_should_use_any(case.anywhere_should_use_any, names, None))
    return checks


def _evaluate_turn(index: int, expected: Expected, turn: TurnTrace) -> list[Check]:
    checks: list[Check] = []
    names = [call.name for call in turn.tool_calls]
    checks.extend(_should_use(expected.should_use, names, index, "tool_selection"))
    checks.extend(_should_use_any(expected.should_use_any, names, index))
    checks.extend(_must_not_use(expected.must_not_use, names, index))
    checks.extend(_arguments(expected.argument_contains, turn, index))
    answer = turn.assistant_text
    for phrase in expected.answer_contains:
        found = _fold(phrase) in _fold(answer)
        checks.append(
            Check(
                metric="answer",
                passed=found,
                detail=f"answer contains {phrase!r}"
                if found
                else f"answer missing {phrase!r}",
                turn_index=index,
            )
        )
    if expected.answer_contains_any:
        matched = [
            phrase
            for phrase in expected.answer_contains_any
            if _fold(phrase) in _fold(answer)
        ]
        checks.append(
            Check(
                metric="answer",
                passed=bool(matched),
                detail=(
                    f"answer matches {matched[0]!r}"
                    if matched
                    else "answer matches none of "
                    + ", ".join(repr(p) for p in expected.answer_contains_any)
                ),
                turn_index=index,
            )
        )
    for phrase in expected.answer_must_not_contain:
        found = _fold(phrase) in _fold(answer)
        checks.append(
            Check(
                metric="hallucination",
                passed=not found,
                detail=(
                    f"answer includes forbidden {phrase!r}"
                    if found
                    else f"answer omits forbidden {phrase!r}"
                ),
                turn_index=index,
            )
        )
    if expected.admit_unknown:
        folded = _fold(answer)
        admitted = any(_fold(phrase) in folded for phrase in _UNKNOWN_PHRASES)
        checks.append(
            Check(
                metric="hallucination",
                passed=admitted,
                detail=(
                    "answer admits the fact is unknown"
                    if admitted
                    else "answer does not admit the fact is unknown"
                ),
                turn_index=index,
            )
        )
    if turn.tool_calls and turn.tool_results < len(turn.tool_calls):
        checks.append(
            Check(
                metric="retrieval",
                passed=False,
                detail=(
                    f"{len(turn.tool_calls)} tool calls and {turn.tool_results} results"
                ),
                turn_index=index,
            )
        )
    elif turn.tool_calls:
        checks.append(
            Check(
                metric="retrieval",
                passed=True,
                detail=f"{turn.tool_results} tool results for {len(turn.tool_calls)} calls",
                turn_index=index,
            )
        )
    return checks


def _should_use(
    specs: list[str], names: list[str], turn_index: int | None, metric: str
) -> list[Check]:
    checks: list[Check] = []
    for spec in specs:
        allowed = expand_spec(spec)
        used = sorted({name for name in names if _same_tool(name, allowed)})
        checks.append(
            Check(
                metric=metric,
                passed=bool(used),
                detail=(
                    f"used {spec} via {', '.join(used)}"
                    if used
                    else f"did not use {spec}"
                ),
                turn_index=turn_index,
            )
        )
    return checks


def _should_use_any(
    specs: list[str], names: list[str], turn_index: int | None
) -> list[Check]:
    if not specs:
        return []
    used = sorted(
        {
            name
            for spec in specs
            for name in names
            if _same_tool(name, expand_spec(spec))
        }
    )
    return [
        Check(
            metric="tool_selection",
            passed=bool(used),
            detail=(
                f"used one of {', '.join(specs)} via {', '.join(used)}"
                if used
                else f"did not use any of {', '.join(specs)}"
            ),
            turn_index=turn_index,
        )
    ]


def _must_not_use(specs: list[str], names: list[str], turn_index: int) -> list[Check]:
    checks: list[Check] = []
    for spec in specs:
        blocked = expand_spec(spec)
        used = sorted({name for name in names if _same_tool(name, blocked)})
        checks.append(
            Check(
                metric="tool_avoidance",
                passed=not used,
                detail=(
                    f"used forbidden {spec} via {', '.join(used)}"
                    if used
                    else f"avoided {spec}"
                ),
                turn_index=turn_index,
            )
        )
    return checks


def _arguments(
    specs: dict[str, list[str]], turn: TurnTrace, turn_index: int
) -> list[Check]:
    checks: list[Check] = []
    for spec, phrases in specs.items():
        allowed = expand_spec(spec)
        calls = [call for call in turn.tool_calls if _same_tool(call.name, allowed)]
        blob = " ".join(_flatten(call.arguments) for call in calls).lower()
        for phrase in phrases:
            found = phrase.lower() in blob
            checks.append(
                Check(
                    metric="tool_arguments",
                    passed=found,
                    detail=(
                        f"{spec} arguments contain {phrase!r}"
                        if found
                        else f"{spec} arguments missing {phrase!r}"
                    ),
                    turn_index=turn_index,
                )
            )
    return checks


def _flatten(value: object) -> str:
    if isinstance(value, dict):
        return " ".join(_flatten(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_flatten(item) for item in value)
    return str(value)
