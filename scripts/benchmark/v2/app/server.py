"""
Uniform memory-system container (one per system, selected by $SYSTEM).

Contract (HTTP):
  GET  /health                     -> {"status","system"}
  POST /reset                      -> {"ok"}            clear store for a fresh run
  POST /ingest  {text,session_id}  -> {"ok"}            store one statement
  POST /flush                      -> {"ok"}            block until queryable
  POST /retrieve {query}           -> {"contexts":[..]} raw memory via native API
  POST /answer  {question}         -> {"answer","contexts"}  retrieve + answerer

The orchestrator (host) only ever speaks this contract — no agent logic or
vendor SDKs run on the host.
"""

from __future__ import annotations

import os
import subprocess
import time

from fastapi import FastAPI
from pydantic import BaseModel

import answerer
from backends import make_backend

SYSTEM = os.environ.get("SYSTEM", "naive").lower()

# Mem0 talks to LM Studio, which rejects response_format=json_object; run the
# translating proxy inside this container so Mem0 can reach the same model.
if SYSTEM == "mem0":
    subprocess.Popen(
        ["python", "lmstudio_proxy.py"],
        env={**os.environ, "LMS_TARGET": os.environ.get("LMS_TARGET", "http://192.168.0.203:1234"),
             "PROXY_PORT": "1235"},
    )
    time.sleep(2)

app = FastAPI()
backend = make_backend()


class IngestBody(BaseModel):
    text: str
    session_id: str = "s"


class QueryBody(BaseModel):
    query: str


class QuestionBody(BaseModel):
    question: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "system": backend.name}


@app.post("/reset")
def reset() -> dict:
    backend.reset()
    return {"ok": True}


@app.post("/ingest")
def ingest(body: IngestBody) -> dict:
    backend.ingest(body.text, body.session_id)
    return {"ok": True}


@app.post("/flush")
def flush() -> dict:
    backend.flush()
    return {"ok": True}


@app.post("/retrieve")
def retrieve(body: QueryBody) -> dict:
    return {"contexts": backend.retrieve(body.query)}


@app.post("/answer")
def answer(body: QuestionBody) -> dict:
    contexts = backend.retrieve(body.question)
    ans = answerer.answer(body.question, contexts)
    return {"answer": ans, "contexts": contexts}
