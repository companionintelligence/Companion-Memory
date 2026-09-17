"""Persona, question, and result schemas + a stdlib JSON-schema validator.

Personas are JSON files with:
  {
    "persona_id": "jordan_rivera",
    "name": "Jordan Rivera",
    "description": "...",
    "facts": [...],                    # optional, free-form notes
    "sessions": [
      {"id": "sess_1", "messages": [{"role": "user", "content": "..."}, ...]}
    ],
    "eval_questions": [
      {"id": "q001", "category": "flat-recall",
       "question": "Where does Jordan live?",
       "keywords": ["Austin", "Texas"], "answer": "Austin, Texas"}
    ]
  }

`validate_persona(data)` returns the list of errors found, or [] if valid. The
benchmark refuses to run against an invalid persona — silent JSON typos that
sneak into a category name or a missing keyword list break every downstream
report row, so fail fast.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class EvalQuestion:
    id: str
    question: str
    keywords: list[str]
    category: str
    answer: str = ""

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> EvalQuestion:
        return cls(
            id=raw["id"],
            question=raw["question"],
            keywords=list(raw.get("keywords", [])),
            category=raw["category"],
            answer=raw.get("answer", ""),
        )


@dataclass
class QuestionResult:
    question_id: str
    question: str
    category: str
    keywords: list[str]
    context: str
    hit: bool
    latency_ms: float
    reason: str = ""


@dataclass
class SystemResult:
    system_name: str
    ingest_total_ms: float
    flush_total_ms: float
    question_results: list[QuestionResult] = field(default_factory=list)
    error: str = ""

    @property
    def total_questions(self) -> int:
        return len(self.question_results)

    @property
    def questions_answered(self) -> int:
        return sum(1 for r in self.question_results if r.hit)

    @property
    def overall_score(self) -> float:
        return (
            self.questions_answered / self.total_questions
            if self.total_questions
            else 0.0
        )

    def score_for_category(self, category: str) -> tuple[int, int]:
        qs = [r for r in self.question_results if r.category == category]
        return (sum(1 for r in qs if r.hit), len(qs))

    @property
    def avg_search_latency_ms(self) -> float:
        lats = [r.latency_ms for r in self.question_results]
        return sum(lats) / len(lats) if lats else 0.0


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

_REQUIRED_PERSONA = ("persona_id", "name", "sessions", "eval_questions")
_REQUIRED_SESSION = ("id", "messages")
_REQUIRED_QUESTION = ("id", "question", "category", "keywords")


def validate_persona(data: Any) -> list[str]:
    """Return a list of human-readable error strings; empty list = valid."""
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["persona must be a JSON object"]

    for key in _REQUIRED_PERSONA:
        if key not in data:
            errors.append(f"missing top-level field: {key}")

    sessions = data.get("sessions", [])
    if not isinstance(sessions, list) or not sessions:
        errors.append("sessions must be a non-empty list")
    else:
        seen_session_ids: set[str] = set()
        for i, sess in enumerate(sessions):
            if not isinstance(sess, dict):
                errors.append(f"sessions[{i}] must be an object")
                continue
            for k in _REQUIRED_SESSION:
                if k not in sess:
                    errors.append(f"sessions[{i}] missing {k}")
            sid = sess.get("id")
            if sid in seen_session_ids:
                errors.append(f"duplicate session id: {sid}")
            if isinstance(sid, str):
                seen_session_ids.add(sid)
            messages = sess.get("messages", [])
            if not isinstance(messages, list) or not messages:
                errors.append(f"sessions[{i}].messages must be a non-empty list")
                continue
            for j, msg in enumerate(messages):
                if (
                    not isinstance(msg, dict)
                    or "role" not in msg
                    or "content" not in msg
                ):
                    errors.append(f"sessions[{i}].messages[{j}] must have role+content")

    questions = data.get("eval_questions", [])
    if not isinstance(questions, list) or not questions:
        errors.append("eval_questions must be a non-empty list")
    else:
        seen_q_ids: set[str] = set()
        for i, q in enumerate(questions):
            if not isinstance(q, dict):
                errors.append(f"eval_questions[{i}] must be an object")
                continue
            for k in _REQUIRED_QUESTION:
                if k not in q:
                    errors.append(f"eval_questions[{i}] missing {k}")
            qid = q.get("id")
            if qid in seen_q_ids:
                errors.append(f"duplicate question id: {qid}")
            if isinstance(qid, str):
                seen_q_ids.add(qid)
            kws = q.get("keywords", [])
            if not isinstance(kws, list) or not kws:
                errors.append(f"eval_questions[{i}] keywords must be a non-empty list")

    return errors
