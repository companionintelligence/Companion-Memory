"""Scorers — verdicts on whether a retrieved context answers a question.

A scorer is a callable ``(EvalQuestion, context: str) -> (hit, reason)``.

Two are shipped:

- :func:`score_keyword` — deterministic lexical overlap. Fast and reproducible,
  but it rewards verbatim text (a raw-chunk dump trivially wins) and punishes
  systems that paraphrase. Good for regression, bad for cross-architecture
  comparison.

- :func:`make_llm_scorer` — an LLM judge graded against a gold answer with a
  strict JSON-schema verdict. Credits paraphrase + synonyms, penalises
  contradictory dumps, and is the fair way to compare extraction-based memory
  against raw retrieval. Bound to any OpenAI-compatible Chat Completions endpoint
  (LM Studio, vLLM, llama.cpp, OpenAI itself).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable

from .schema import EvalQuestion

Scorer = Callable[[EvalQuestion, str], tuple[bool, str]]


# ---------------------------------------------------------------------------
# Keyword scorer
# ---------------------------------------------------------------------------


def score_keyword(question: EvalQuestion, context: str) -> tuple[bool, str]:
    """Hit when at least one keyword appears in the retrieved context (case-insensitive)."""
    ctx_lower = context.lower()
    for kw in question.keywords:
        if kw.lower() in ctx_lower:
            return True, ""
    return False, ""


# ---------------------------------------------------------------------------
# LLM judge
# ---------------------------------------------------------------------------

JUDGE_SYSTEM_PROMPT = (
    "You grade an AI memory system. You are given a QUESTION, the GOLD ANSWER, "
    "and the CONTEXT that a memory system retrieved. Decide whether the CONTEXT "
    "contains enough information to answer the QUESTION correctly.\n"
    "Rules:\n"
    "- The CONTEXT is drawn from a SINGLE person's personal memory store. That "
    "person is the subject of the QUESTION. So 'the user', 'the narrator', 'I', "
    "and the subject's own name all refer to the SAME person — treat a fact about "
    "'the user' as a fact about the person the question asks about. Do NOT mark "
    "something wrong merely because it says 'the user' instead of the name.\n"
    "- correct=true only if the CONTEXT states or directly implies the GOLD ANSWER. "
    "Paraphrases and synonyms count.\n"
    "- If the CONTEXT lacks the answer, correct=false.\n"
    "- For questions about the CURRENT state of something that changed over time, "
    "correct=true only if the CONTEXT makes the current/latest value identifiable; "
    "if it dumps both old and new values with no way to tell which is current, "
    "correct=false.\n"
    "- Judge only what the CONTEXT supports — do not use outside knowledge."
)

_JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "correct": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["correct", "reason"],
    "additionalProperties": False,
}


def make_llm_scorer(
    base_url: str,
    model: str,
    api_key: str = "",
    timeout: float = 120.0,
    *,
    http_post: Callable[[str, bytes, dict, float], bytes] | None = None,
) -> Scorer:
    """Build an LLM-judge scorer bound to an OpenAI-compatible Chat Completions endpoint.

    Set ``http_post`` to inject a stub in tests; production code uses urllib.
    """
    chat_url = f"{base_url.rstrip('/')}/v1/chat/completions"

    def _default_post(url: str, body: bytes, headers: dict, t: float) -> bytes:
        req = urllib.request.Request(url, data=body, method="POST")
        for k, v in headers.items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=t) as resp:
            return resp.read()

    post = http_post or _default_post

    def score(question: EvalQuestion, context: str) -> tuple[bool, str]:
        if not context.strip():
            return False, "empty context"

        gold = question.answer or ", ".join(question.keywords)
        user_msg = (
            f"QUESTION: {question.question}\nGOLD ANSWER: {gold}\nCONTEXT:\n{context}"
        )
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            "temperature": 0,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "verdict",
                    "strict": True,
                    "schema": _JUDGE_SCHEMA,
                },
            },
        }
        body = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        try:
            raw = post(chat_url, body, headers, timeout)
            resp = json.loads(raw)
            msg = resp.get("choices", [{}])[0].get("message", {})
            # Some servers (e.g. reasoning models) return the structured JSON in
            # ``reasoning_content`` instead of ``content`` — accept both.
            content = msg.get("content") or msg.get("reasoning_content") or ""
            verdict = json.loads(content)
            return bool(verdict.get("correct")), str(verdict.get("reason", ""))
        except (urllib.error.URLError, ValueError, KeyError) as exc:
            return False, f"judge error: {exc}"

    return score
