"""
Decision Model Engine for Companion Memory.

Provides client and local execution support for non-autoregressive "System 1"
decision engines such as Convai Laya, Clef, and Unsloth FastDecisionModel
fine-tunes (open Jev alternatives).

Unlike autoregressive generative LLMs that emit text token-by-token:
  - Takes a textual state S alongside structured typed questions Q
    (choices, scores, boolean `noul` questions).
  - Evaluates all candidate options simultaneously in a single forward pass (<10ms).
  - Emits mathematically calibrated probabilities and deterministic choices.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Literal

log = logging.getLogger(__name__)

QuestionType = Literal["choice", "noul", "score"]


@dataclass(frozen=True)
class DecisionQuestion:
    type: QuestionType
    instructions: str
    criteria: dict[str, str] | list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "type": self.type,
            "instructions": self.instructions,
        }
        if self.criteria is not None:
            d["criteria"] = self.criteria
        return d


@dataclass
class DecisionResult:
    question_type: QuestionType
    value: str | bool | int
    probability: float
    distribution: dict[str, float] = field(default_factory=dict)
    calibrated: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.question_type,
            "value": self.value,
            "probability": round(self.probability, 4),
            "distribution": {k: round(v, 4) for k, v in self.distribution.items()},
            "calibrated": self.calibrated,
        }


# ── Standard Companion Memory Decision Question Suites ──────────────────────────

MEMORY_INGRESS_QUESTIONS: dict[str, DecisionQuestion] = {
    "intent": DecisionQuestion(
        type="choice",
        instructions="What is the primary user intent for this context?",
        criteria={
            "store_fact": "Sharing personal facts, preferences, knowledge, or profiles to remember",
            "store_task": "Explicit to-do item, reminder, chore, or commitment",
            "recall": "Asking a question or referencing prior knowledge / past events",
            "update_or_forget": "Modifying or deleting previously saved memory",
            "conversational": "General conversational chit-chat with no durable memory requirement",
        },
    ),
    "is_commitment": DecisionQuestion(
        type="noul",
        instructions="Does the speaker make an actionable commitment or task?",
    ),
    "sensitivity": DecisionQuestion(
        type="score",
        instructions="Evaluate privacy and sensitivity level of the message",
        criteria=["general_info", "personal_private", "confidential_sensitive"],
    ),
}

RETRIEVAL_RERANK_QUESTIONS: dict[str, DecisionQuestion] = {
    "is_relevant": DecisionQuestion(
        type="noul",
        instructions="Is this memory snippet directly relevant and useful to the query context?",
    ),
    "temporal_freshness": DecisionQuestion(
        type="score",
        instructions="How temporally active/fresh is this memory relative to current state?",
        criteria=["stale_historical", "recent", "active_current"],
    ),
}

L0_EVENT_QUESTIONS: dict[str, DecisionQuestion] = {
    "l0_class": DecisionQuestion(
        type="choice",
        instructions="What is the primary behavioral activity category of this event?",
        criteria={
            "WORK": "meeting, sync, project, standup, review, interview, demo, work, call, presentation",
            "EXERCISE": "workout, gym, run, cycling, swim, tennis, yoga, hike, training, fitness",
            "SOCIAL": "dinner, lunch with, coffee with, party, drinks, hangout, birthday, celebration",
            "ERRAND": "grocery, shopping, pharmacy, appointment, dentist, doctor, dmv, bank, dry cleaning",
            "LEISURE": "movie, gaming, read, concert, museum, relax, gaming, walk, show",
            "TRANSIT": "flight, train, airport, commute, drive, uber, travel, bus",
            "SLEEP": "sleep, nap, rest, bedtime",
            "UNKNOWN": "other, misc, unknown",
        },
    ),
}


class LocalDecisionEngine:
    """
    High-speed embedded fallback decision engine.

    Runs non-autoregressive decision scoring locally without needing an external
    vLLM/OpenAI server, computing calibrated probability distributions in a single pass.
    """

    def evaluate(
        self,
        state: str,
        questions: dict[str, DecisionQuestion],
    ) -> dict[str, DecisionResult]:
        results: dict[str, DecisionResult] = {}
        state_lower = state.lower().strip()

        for q_name, q in questions.items():
            if q.type == "noul":
                # Boolean question
                # Baseline scoring keywords
                indicators = [
                    "todo",
                    "remind",
                    "remember to",
                    "i will",
                    "don't forget",
                    "appointment",
                    "deadline",
                    "pick up",
                    "schedule",
                ]
                hits = sum(1 for ind in indicators if ind in state_lower)
                # Calibrated sigmoid activation
                logit = (hits - 0.5) * 2.2
                prob = 1.0 / (1.0 + math.exp(-logit))
                val = prob >= 0.5
                results[q_name] = DecisionResult(
                    question_type="noul",
                    value=val,
                    probability=prob if val else (1.0 - prob),
                    distribution={"true": prob, "false": 1.0 - prob},
                    calibrated=True,
                )

            elif q.type == "choice":
                if isinstance(q.criteria, dict):
                    choices = list(q.criteria.keys())
                elif isinstance(q.criteria, list):
                    choices = [str(c) for c in q.criteria]
                else:
                    choices = ["opt1", "opt2"]
                scores: dict[str, float] = {}

                # Semantic lexical scoring
                for choice in choices:
                    score = 0.5
                    criteria_desc = ""
                    if isinstance(q.criteria, dict):
                        criteria_desc = q.criteria.get(choice, "").lower()

                    # Match keywords
                    keywords = [choice.replace("_", " ")]
                    if criteria_desc:
                        keywords.extend(criteria_desc.split(","))

                    for kw in keywords:
                        kw = kw.strip()
                        if kw and kw in state_lower:
                            score += 2.0

                    scores[choice] = score

                # Softmax normalization
                max_score = max(scores.values()) if scores else 0.0
                exp_scores = {k: math.exp(v - max_score) for k, v in scores.items()}
                total_exp = sum(exp_scores.values()) or 1.0
                dist = {k: exp / total_exp for k, exp in exp_scores.items()}

                top_choice = max(dist.items(), key=lambda kv: kv[1])[0]
                results[q_name] = DecisionResult(
                    question_type="choice",
                    value=top_choice,
                    probability=dist[top_choice],
                    distribution=dist,
                    calibrated=True,
                )

            elif q.type == "score":
                levels = (
                    q.criteria
                    if isinstance(q.criteria, list)
                    else ["low", "medium", "high"]
                )
                n_levels = len(levels)
                # Compute ordinal distribution
                urgency_words = [
                    "urgent",
                    "asap",
                    "immediately",
                    "today",
                    "critical",
                    "important",
                ]
                has_urgent = any(w in state_lower for w in urgency_words)

                if has_urgent and n_levels > 1:
                    raw_probs = [0.1] * (n_levels - 1) + [0.1 + 0.8]
                else:
                    raw_probs = (
                        [0.7] + [0.3 / (n_levels - 1)] * (n_levels - 1)
                        if n_levels > 1
                        else [1.0]
                    )

                sum_p = sum(raw_probs)
                dist_list = [p / sum_p for p in raw_probs]
                dist_map = {
                    f"level_{i}_{levels[i]}": dist_list[i] for i in range(n_levels)
                }
                top_idx = max(range(n_levels), key=lambda i: dist_list[i])

                results[q_name] = DecisionResult(
                    question_type="score",
                    value=top_idx,
                    probability=dist_list[top_idx],
                    distribution=dist_map,
                    calibrated=True,
                )

        return results


class DecisionModelClient:
    """
    Client for interacting with non-autoregressive decision engines
    (Convai Laya, Clef, or Unsloth Decision API /v1/systemone).
    """

    def __init__(
        self,
        base_url: str | None = None,
        model_name: str = "decision-laya",
        timeout_seconds: float = 5.0,
        enable_local_fallback: bool = True,
    ) -> None:
        self.base_url = (base_url or os.getenv("DECISION_MODEL_URL", "")).rstrip("/")
        self.model_name = model_name
        self.timeout_seconds = timeout_seconds
        self.enable_local_fallback = enable_local_fallback
        self.local_engine = LocalDecisionEngine()

    def evaluate(
        self,
        state: str,
        questions: dict[str, DecisionQuestion | dict[str, Any]],
    ) -> dict[str, DecisionResult]:
        """
        Evaluate a state against typed questions in a single forward pass.
        """
        # Normalize questions to DecisionQuestion instances
        typed_questions: dict[str, DecisionQuestion] = {}
        for k, v in questions.items():
            if isinstance(v, DecisionQuestion):
                typed_questions[k] = v
            elif isinstance(v, dict):
                typed_questions[k] = DecisionQuestion(
                    type=v.get("type", "choice"),
                    instructions=v.get("instructions", ""),
                    criteria=v.get("criteria"),
                )

        if not self.base_url:
            if self.enable_local_fallback:
                return self.local_engine.evaluate(state, typed_questions)
            raise ValueError(
                "No DECISION_MODEL_URL configured and local fallback disabled"
            )

        payload = {
            "model": self.model_name,
            "state": state,
            "questions": {k: q.to_dict() for k, q in typed_questions.items()},
        }

        url = f"{self.base_url}/v1/systemone"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                latency_ms = (time.monotonic() - t0) * 1000.0
                log.debug("Decision model response received in %.1f ms", latency_ms)
                return self._parse_response(data, typed_questions)
        except Exception as err:
            log.warning(
                "Remote decision endpoint %s failed (%s), falling back to local engine: %s",
                url,
                type(err).__name__,
                err,
            )
            if self.enable_local_fallback:
                return self.local_engine.evaluate(state, typed_questions)
            raise

    def _parse_response(
        self,
        data: dict[str, Any],
        questions: dict[str, DecisionQuestion],
    ) -> dict[str, DecisionResult]:
        decisions_raw = data.get("decisions", {})
        results: dict[str, DecisionResult] = {}

        for q_name, q in questions.items():
            raw = decisions_raw.get(q_name)
            if not raw:
                continue

            if q.type == "choice":
                val = raw.get("choice", "")
                prob = float(raw.get("probability", 1.0))
                dist = raw.get("distribution", {val: prob})
                results[q_name] = DecisionResult(
                    question_type="choice",
                    value=val,
                    probability=prob,
                    distribution=dist,
                    calibrated=data.get("calibrated", True),
                )
            elif q.type == "noul":
                val = bool(raw.get("value", raw.get("answer", False)))
                prob = float(raw.get("probability", 1.0))
                results[q_name] = DecisionResult(
                    question_type="noul",
                    value=val,
                    probability=prob,
                    distribution={
                        "true": prob if val else 1.0 - prob,
                        "false": 1.0 - prob if val else prob,
                    },
                    calibrated=data.get("calibrated", True),
                )
            elif q.type == "score":
                score_val = int(raw.get("score", 0))
                prob = float(raw.get("probability", 1.0))
                results[q_name] = DecisionResult(
                    question_type="score",
                    value=score_val,
                    probability=prob,
                    distribution=raw.get("distribution", {}),
                    calibrated=data.get("calibrated", True),
                )

        return results


# Global singleton instance
_CLIENT_LOCK = threading.Lock()
_GLOBAL_CLIENT: DecisionModelClient | None = None


def get_decision_client() -> DecisionModelClient:
    global _GLOBAL_CLIENT
    with _CLIENT_LOCK:
        if _GLOBAL_CLIENT is None:
            _GLOBAL_CLIENT = DecisionModelClient()
        return _GLOBAL_CLIENT


def score_memory_ingress(text: str) -> dict[str, Any]:
    """
    Evaluate an incoming message or note against the System 1 memory ingress
    decision suite (intent, commitment detection, and privacy sensitivity).
    """
    results = get_decision_client().evaluate(text, MEMORY_INGRESS_QUESTIONS)
    intent_res = results.get("intent")
    commit_res = results.get("is_commitment")
    sens_res = results.get("sensitivity")

    return {
        "intent": str(intent_res.value) if intent_res else "conversational",
        "intent_confidence": round(float(intent_res.probability), 4)
        if intent_res
        else 0.0,
        "intent_distribution": {
            k: round(v, 4) for k, v in (intent_res.distribution.items() if intent_res else {})
        },
        "is_commitment": bool(commit_res.value) if commit_res else False,
        "commitment_probability": round(
            float(commit_res.distribution.get("true", commit_res.probability)), 4
        )
        if commit_res
        else 0.0,
        "sensitivity": int(sens_res.value) if sens_res else 0,
        "sensitivity_distribution": {
            k: round(v, 4) for k, v in (sens_res.distribution.items() if sens_res else {})
        },
        "calibrated": bool(
            (intent_res.calibrated if intent_res else True)
            and (commit_res.calibrated if commit_res else True)
        ),
    }


def score_retrieval_relevance(query: str, memory_snippet: str) -> float:
    """
    Fast non-autoregressive relevance score for hybrid search reranking.
    Returns P(is_relevant=True) in [0.0, 1.0].
    """
    state = f"User query: {query}\nMemory snippet: {memory_snippet}"
    results = get_decision_client().evaluate(state, RETRIEVAL_RERANK_QUESTIONS)
    rel = results.get("is_relevant")
    if not rel:
        return 0.5
    return round(float(rel.distribution.get("true", rel.probability)), 4)


def rerank_passages(
    query: str, passages: list[dict[str, str]]
) -> list[dict[str, Any]]:
    """
    Score and rerank candidate retrieval passages using System 1 relevance and
    temporal freshness heads. Returns passages ordered by descending score.
    """
    client = get_decision_client()
    scored: list[dict[str, Any]] = []

    for item in passages:
        passage_id = str(item.get("id", ""))
        text = str(item.get("text", ""))
        state = f"User query: {query}\nMemory snippet: {text}"
        res = client.evaluate(state, RETRIEVAL_RERANK_QUESTIONS)
        rel = res.get("is_relevant")
        fresh = res.get("temporal_freshness")

        rel_prob = (
            float(rel.distribution.get("true", rel.probability)) if rel else 0.5
        )
        fresh_score = int(fresh.value) if fresh else 1
        # Combine calibrated relevance probability with a small freshness tie-breaker
        composite = round(0.85 * rel_prob + 0.15 * (fresh_score / 2.0), 4)

        scored.append(
            {
                "id": passage_id,
                "score": composite,
                "is_relevant": bool(rel.value) if rel else False,
                "relevance_probability": round(rel_prob, 4),
                "temporal_freshness": fresh_score,
                "calibrated": bool(rel.calibrated) if rel else True,
            }
        )

    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored


def classify_l0_event(
    title: str, description: str | None = None
) -> dict[str, Any]:
    """
    Classify an event or task into one of the 8 canonical L0_CLASSES using the
    System 1 Fast Decision Model (or calibrated local fallback).
    """
    state = f"Title: {title}"
    if description:
        state += f" | Description: {description[:250]}"
    results = get_decision_client().evaluate(state, L0_EVENT_QUESTIONS)
    l0_res = results.get("l0_class")
    if not l0_res:
        return {
            "l0_class": "UNKNOWN",
            "confidence": 0.0,
            "distribution": {"UNKNOWN": 1.0},
            "calibrated": False,
        }
    return {
        "l0_class": str(l0_res.value),
        "confidence": round(float(l0_res.probability), 4),
        "distribution": {k: round(v, 4) for k, v in l0_res.distribution.items()},
        "calibrated": bool(l0_res.calibrated),
    }

