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

LLM_URL = os.environ.get("LLM_URL", "http://192.168.0.202:1234").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "gemma-4-31b-it-abliterated")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "lm-studio")

_SYSTEM = (
    "You are the memory of a personal assistant whose single user is the person "
    "named in the QUESTION. ALL memory entries are about that one user, even when "
    'written in first person ("I") or as "the user" or "the narrator". So a memory '
    'saying "I play violin" IS a fact about the user named in the question. Never '
    "claim the person is not mentioned just because the memory uses 'I' or 'the "
    "user'. Answer in one short sentence using ONLY the memory; only say \"I don't "
    'know" if the specific fact asked for is genuinely absent from the memory.'
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
