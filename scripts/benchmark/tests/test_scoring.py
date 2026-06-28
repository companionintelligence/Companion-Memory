"""Scorer tests — keyword + LLM-judge (with the network stubbed)."""

from __future__ import annotations

import json

from benchmark.schema import EvalQuestion
from benchmark.scoring import JUDGE_SYSTEM_PROMPT, make_llm_scorer, score_keyword


def _q() -> EvalQuestion:
    return EvalQuestion(
        id="q1", question="Where does Jordan live?",
        keywords=["Austin", "Texas"], category="flat-recall", answer="Austin, Texas",
    )


# ── keyword ─────────────────────────────────────────────────────────────────

def test_keyword_hit_is_case_insensitive():
    hit, _ = score_keyword(_q(), "Jordan moved to austin last spring.")
    assert hit


def test_keyword_miss_when_no_keyword_present():
    hit, _ = score_keyword(_q(), "Jordan likes hiking.")
    assert not hit


def test_keyword_treats_empty_context_as_miss():
    assert score_keyword(_q(), "") == (False, "")


# ── LLM judge ───────────────────────────────────────────────────────────────

def _stub_post(response_json: dict):
    """Return an http_post callable that records the request and returns ``response_json``."""
    captured = {}

    def fake(url: str, body: bytes, headers: dict, timeout: float) -> bytes:
        captured["url"] = url
        captured["headers"] = dict(headers)
        captured["payload"] = json.loads(body)
        return json.dumps(response_json).encode()

    return fake, captured


def _verdict_response(correct: bool, reason: str = "") -> dict:
    return {
        "choices": [
            {
                "message": {
                    "content": json.dumps({"correct": correct, "reason": reason}),
                }
            }
        ]
    }


def test_llm_scorer_passes_system_prompt_and_gold_answer():
    post, captured = _stub_post(_verdict_response(True, "yes"))
    scorer = make_llm_scorer("http://judge:1234", "test-model", "secret", http_post=post)
    hit, reason = scorer(_q(), "Jordan moved to Austin, Texas last spring.")
    assert hit and reason == "yes"
    assert captured["url"] == "http://judge:1234/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer secret"
    assert captured["headers"]["Content-Type"] == "application/json"
    msgs = captured["payload"]["messages"]
    assert msgs[0]["role"] == "system" and msgs[0]["content"] == JUDGE_SYSTEM_PROMPT
    assert "Austin, Texas" in msgs[1]["content"]  # gold answer relayed


def test_llm_scorer_empty_context_short_circuits_without_network():
    def must_not_call(*_a, **_k):
        raise AssertionError("must not call the judge for empty context")

    scorer = make_llm_scorer("http://judge:1234", "m", http_post=must_not_call)
    assert scorer(_q(), "   \n  ") == (False, "empty context")


def test_llm_scorer_returns_judge_negative_verdict():
    post, _ = _stub_post(_verdict_response(False, "lacks the answer"))
    scorer = make_llm_scorer("http://judge:1234", "m", http_post=post)
    hit, reason = scorer(_q(), "Jordan likes hiking.")
    assert not hit and "lacks" in reason


def test_llm_scorer_handles_reasoning_content_field():
    # Some servers return the JSON in ``reasoning_content`` instead of ``content``.
    response = {
        "choices": [
            {
                "message": {
                    "content": None,
                    "reasoning_content": json.dumps({"correct": True, "reason": "y"}),
                }
            }
        ]
    }
    post, _ = _stub_post(response)
    scorer = make_llm_scorer("http://judge:1234", "m", http_post=post)
    hit, _ = scorer(_q(), "Jordan lives in Austin.")
    assert hit


def test_llm_scorer_treats_judge_error_as_no_hit():
    def boom(*_a, **_k):
        raise ValueError("connection dropped")

    scorer = make_llm_scorer("http://judge:1234", "m", http_post=boom)
    hit, reason = scorer(_q(), "Jordan lives in Austin.")
    assert not hit and "judge error" in reason
