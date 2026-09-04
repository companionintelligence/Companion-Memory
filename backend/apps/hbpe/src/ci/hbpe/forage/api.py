"""Forage routes on the HBPE sidecar. Ticket CI-Active-Inference#19.

GET /forage returns the current trial. `autoload=1` (default) starts the Sam
Saturday fixture when none is running — that keeps the original tests. The API
posts a memory-lake spec (`kind=memory`) so Forecast reads the user's indexes.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from .lake import lake_from_spec, sam_saturday_lake
from .persist import write_trial
from .trial import ForageError, ForageTrial

router = APIRouter(prefix="/forage", tags=["forage"])


class InterestSpec(BaseModel):
    branch: str
    person: str
    activities: list[str] = Field(default_factory=list)


class LakeItemSpec(BaseModel):
    id: str
    label: str
    observation: str = "none"
    supports_branches: list[str] = Field(default_factory=list)
    supports_people: list[str] = Field(default_factory=list)
    source: str = "search"


class LakeSpec(BaseModel):
    question: str = "What happens next"
    horizon: str = "7d"
    subject: str = ""
    seed: int = 0
    branches: list[str]
    people: list[str]
    cues: list[str] | None = None
    items: list[LakeItemSpec]
    branch_prior: dict[str, float] = Field(default_factory=dict)
    interests: list[InterestSpec] = Field(default_factory=list)


class IngestSpec(BaseModel):
    items: list[LakeItemSpec]


class TrialStore:
    def __init__(self) -> None:
        self.trials: dict[str, ForageTrial] = {}

    def start(self, user_id: str, seed: int = 0) -> ForageTrial:
        model, process_A, items, truth = sam_saturday_lake()
        trial = ForageTrial(
            model=model,
            process_A=process_A,
            items=items,
            truth=truth,
            rng=np.random.default_rng(seed),
        )
        self.trials[user_id] = trial
        self.persist(user_id)
        return trial

    def start_from_spec(self, user_id: str, spec: LakeSpec) -> ForageTrial:
        model, process_A, items, truth = lake_from_spec(spec.model_dump())
        trial = ForageTrial(
            model=model,
            process_A=process_A,
            items=items,
            truth=truth,
            question=spec.question,
            subject=spec.subject,
            horizon=spec.horizon,
            rng=np.random.default_rng(spec.seed),
        )
        self.trials[user_id] = trial
        self.persist(user_id)
        return trial

    def get_or_start(self, user_id: str) -> ForageTrial:
        existing = self.trials.get(user_id)
        if existing is not None:
            return existing
        return self.start(user_id)

    def persist(self, user_id: str) -> None:
        trial = self.trials[user_id]
        write_trial(user_id, {"user_id": user_id, **trial.snapshot()})


store = TrialStore()


def _user_id(user_id: str | None) -> str:
    if not user_id:
        raise HTTPException(status_code=401, detail="user_id is required")
    return user_id


def _payload(user_id: str, trial: ForageTrial) -> dict:
    return {"user_id": user_id, **trial.view()}


def _run(user_id: str, fn):
    trial = store.get_or_start(user_id)
    try:
        fn(trial)
    except ForageError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    store.persist(user_id)
    return _payload(user_id, trial)


@router.get("")
@router.get("/")
def get_trial(
    user_id: str | None = Query(None),
    autoload: bool = Query(True),
) -> dict:
    uid = _user_id(user_id)
    existing = store.trials.get(uid)
    if existing is not None:
        return _payload(uid, existing)
    if not autoload:
        raise HTTPException(status_code=404, detail="no forage trial")
    trial = store.start(uid)
    return _payload(uid, trial)


@router.post("/ask")
def ask(
    user_id: str | None = Query(None),
    seed: int = Query(0),
    spec: LakeSpec | None = None,
) -> dict:
    uid = _user_id(user_id)
    try:
        trial = (
            store.start_from_spec(uid, spec)
            if spec is not None
            else store.start(uid, seed=seed)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _payload(uid, trial)


@router.post("/ingest")
def ingest(body: IngestSpec, user_id: str | None = Query(None)) -> dict:
    uid = _user_id(user_id)
    trial = store.trials.get(uid)
    if trial is None:
        raise HTTPException(status_code=404, detail="no forage trial")
    try:
        trial.ingest([item.model_dump() for item in body.items])
    except ForageError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    store.persist(uid)
    return _payload(uid, trial)


@router.post("/sample")
def sample(user_id: str | None = Query(None)) -> dict:
    return _run(_user_id(user_id), lambda trial: trial.sample_next())


@router.post("/pin/{name}")
def pin_branch(name: str, user_id: str | None = Query(None)) -> dict:
    return _run(_user_id(user_id), lambda trial: trial.set_pin(name))


@router.delete("/pin")
def unpin(user_id: str | None = Query(None)) -> dict:
    return _run(_user_id(user_id), lambda trial: trial.clear_pin())


# Standalone app so the original forage tests can mount just this router.
app = FastAPI(title="CI Forage", version="0.2.0")
app.include_router(router)
