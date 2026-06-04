"""
Shared answerer: given a question and the memory a system retrieved, write a
final answer with one fixed LLM (LM Studio gemma). This is the "agent" in each
container — a retrieval-augmented responder. Holding the answerer constant
across systems means we compare memory layers, not answer-writers.
"""

from __future__ import annotations

import json
import os
import urllib.request

LLM_URL = os.environ.get("LLM_URL", "http://192.168.0.203:1234").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "ornstein-3.6-27b")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "lm-studio")

_SYSTEM = (
    "You are the memory of a personal assistant. The user is the person named in "
    'the QUESTION; memory entries about them are written as "the user", "I", or '
    '"the narrator" — bind ALL of these to that name (a memory saying "I play '
    'violin" IS a fact about the named user). The memory ALSO lists facts about '
    "OTHER named people (their favorite foods, cities, jobs); IGNORE those. To "
    "answer, scan for the single entry about THE USER that matches the question "
    '(e.g. for "favorite food", the entry "…the user\'s favorite food…") and '
    "report it. Answer in one short sentence using ONLY the memory. Say \"I don't "
    'know" only if NO entry about the user matches the question.'
)


def answer(question: str, contexts: list[str], timeout: float = 60.0) -> str:
    memory = "\n".join(f"- {c}" for c in contexts if c).strip() or "(no memory retrieved)"
    user = f"MEMORY:\n{memory}\n\nQUESTION: {question}"
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
    }
    req = urllib.request.Request(
        f"{LLM_URL}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    if LLM_API_KEY:
        req.add_header("Authorization", f"Bearer {LLM_API_KEY}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    msg = data.get("choices", [{}])[0].get("message", {})
    return (msg.get("content") or msg.get("reasoning_content") or "").strip()
