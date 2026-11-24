"""Run each user turn, save the trace, then score it.

The loop is the product loop: user message, model, tools, tool results,
model, response, next user message. Scoring happens after the thread is
idle, against the messages the server stored.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .chat import ChatClient
from .evaluate import Check, evaluate_trace
from .schema import Case
from .trace import ConversationTrace, messages_to_trace


@dataclass
class CaseRun:
    case: Case
    trace: ConversationTrace
    checks: list[Check] = field(default_factory=list)
    skipped: str = ""

    def failed(self) -> list[Check]:
        return [check for check in self.checks if not check.passed]


def run_case(case: Case, client: ChatClient, *, score_incomplete: bool) -> CaseRun:
    if case.needs_owner and not score_incomplete:
        return CaseRun(
            case=case,
            trace=ConversationTrace(case_id=case.id, thread_id=""),
            skipped="needs_owner",
        )
    thread_id: str | None = None
    try:
        for turn in case.conversation:
            thread_id = client.turn(turn.content, thread_id)
        assert thread_id is not None
        trace = messages_to_trace(case.id, thread_id, client.messages(thread_id))
    except Exception as exc:
        trace = ConversationTrace(
            case_id=case.id,
            thread_id=thread_id or "",
            error=f"{type(exc).__name__}: {exc}",
        )
    return CaseRun(case=case, trace=trace, checks=evaluate_trace(case, trace))


def run_cases(
    cases: list[Case],
    client: ChatClient,
    *,
    score_incomplete: bool = False,
) -> list[CaseRun]:
    return [run_case(case, client, score_incomplete=score_incomplete) for case in cases]
