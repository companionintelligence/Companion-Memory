"""
FastAPI application for HBPE — Hierarchical Behavioral Prediction Engine.

Lifecycle:
  • On startup: load InferenceEngine per user, start EventIngester background task.
  • On shutdown: stop ingester.

Endpoints:
  GET /health               — liveness probe
  GET /histogram            — 48-bucket 24h behavioral forecast
  POST /invalidate/{date}   — manual cache invalidation (for testing / admin)

The engine registry maps user_id → InferenceEngine.  In a single-user
deployment (Phase 4 target), the registry has one entry loaded from the DB.
In multi-user mode, engines are created on first request and cached.

Implements T4.4 (CI-Server-k64) and integrates T4.3 ingester.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import date
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

from ci.pipeline.histogram_api import build_histogram

log = logging.getLogger(__name__)

# Global engine registry: user_id → InferenceEngine
_engines: dict = {}
_ingester = None
_temporal_client = None

# Fixed workflow ID prefixes for deduplication
_BOOTSTRAP_WF_PREFIX = "hbpe-bootstrap"
_NIGHTLY_WF_PREFIX   = "hbpe-nightly"

def _get_or_create_engine(user_id: str):
    if user_id not in _engines:
        from ci.pipeline.inference_engine import InferenceEngine
        log.info("Creating InferenceEngine for user %s", user_id[:8])
        _engines[user_id] = InferenceEngine(user_id)
    return _engines[user_id]


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ingester, _temporal_client

    # Init database connection pool early to fail fast
    from ci.database import init_db
    init_db()

    # Connect Temporal client so /trigger can start workflows. Non-fatal if
    # Temporal is unavailable — /trigger will surface a clear 503 instead.
    try:
        from temporalio.client import Client
        from ci.config import settings
        _temporal_client = await Client.connect(
            settings.temporal_address, namespace=settings.temporal_namespace
        )
        log.info("Temporal client connected")
    except Exception:
        log.exception("Could not connect Temporal client; /trigger will return 503")

    # Start event ingester
    from ci.pipeline.ingester import EventIngester
    _ingester = EventIngester(_engines)
    await _ingester.start()

    yield

    # Shutdown
    if _ingester:
        await _ingester.stop()


app = FastAPI(
    title       = "HBPE — Hierarchical Behavioral Prediction Engine",
    version     = "0.2.0",
    lifespan    = lifespan,
)


async def _active_workflow_status(uid: str) -> Optional[str]:
    """
    Query the current step of any *running* HBPE workflow for uid.

    Returns a status string like 'BOOTSTRAP:train' or 'NIGHTLY:lora', or None
    if no workflow is actively running. Closed workflows are ignored even if
    their `current_step` variable was never set to "done" — otherwise a
    crash mid-step would leave the API reporting a stale status forever.
    """
    if not _temporal_client:
        return None

    import asyncio
    from temporalio.client import WorkflowExecutionStatus

    for wf_type, prefix in [
        ("BOOTSTRAP", _BOOTSTRAP_WF_PREFIX),
        ("NIGHTLY",   _NIGHTLY_WF_PREFIX),
    ]:
        wf_id = f"{prefix}-{uid[:8]}"
        try:
            handle = _temporal_client.get_workflow_handle(wf_id)
            desc = await asyncio.wait_for(handle.describe(), timeout=1.0)
            if desc.status != WorkflowExecutionStatus.RUNNING:
                continue
            step = await asyncio.wait_for(
                handle.query("current_step"), timeout=1.0,
            )
            if step and step != "done":
                return f"{wf_type}:{step}"
        except asyncio.TimeoutError:
            log.warning("Temporal status query timed out for %s; reporting none", wf_id)
        except Exception:
            pass  # workflow not found, completed, query not registered, etc.
    return None


async def _resolve_system_status(user_id: str) -> str:
    """
    Status string for the forecast response.

    READY once a checkpoint exists; otherwise the live workflow step
    (e.g. ``BOOTSTRAP:train``) so the UI shows real progress instead of a
    permanent "Waiting to initialize…", falling back to COLD_START when no
    workflow is currently running.
    """
    if _model_exists(user_id):
        return "READY"
    status = await _active_workflow_status(user_id)
    return status or "COLD_START"


@app.get("/health")
async def health() -> dict:
    return {
        "status":   "ok",
        "service":  "hbpe",
        "engines":  list(_engines.keys()),
    }


@app.get("/histogram")
async def histogram(
    user_id: str | None = Query(None, description="User UUID"),
    horizon: str = Query("24h", description="Forecast window (only '24h' supported)"),
) -> dict:
    """
    Return a 48-bucket 24-hour behavioral forecast.

    Response: { horizon, generated_at, buckets: [...48 items...] }
    Each bucket: { bucket_index, start_time, l0_probs, l1_probs, l2_probs, q10, q50, q90 }
    """
    if not user_id:
        raise HTTPException(status_code=401, detail="user_id is required")

    try:
        engine = _get_or_create_engine(user_id)
        system_status = await _resolve_system_status(user_id)
        result = build_histogram(
            engine, horizon=horizon, user_id=user_id, system_status=system_status
        )
        return JSONResponse(content=result)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        log.exception("Histogram generation failed")
        raise HTTPException(status_code=500, detail="Internal error")


@app.post("/invalidate/{date_str}")
async def invalidate_cache(
    date_str: str,
    user_id: str | None = Query(None, description="User UUID"),
) -> dict:
    """
    Manually invalidate the inference cache for a specific date.
    Useful for admin tooling and integration tests.
    """
    if not user_id:
        raise HTTPException(status_code=401, detail="user_id is required")

    try:
        d = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date: {date_str}")

    if user_id in _engines:
        _engines[user_id].invalidate(d)
        return {"invalidated": str(d), "user_id": user_id}
    return {"invalidated": str(d), "user_id": user_id, "note": "no engine loaded"}


def _model_exists(user_id: str) -> bool:
    """Return True if this user has an HMT checkpoint and predictions can be served."""
    from ci.model.checkpoints import model_exists
    return model_exists(user_id)


@app.post("/trigger")
async def trigger_pipeline(
    user_id: str | None = Query(None, description="User UUID"),
) -> dict:
    """
    Manually trigger the HBPE pipeline for the user.

    Cold start (no checkpoint): runs BootstrapHBPEWorkflow — full pipeline from
    labeling through model training, calibration, and ONNX export.

    Warm start (checkpoint exists): runs NightlyHBPEWorkflow — incremental
    label/sweep/LoRA update.

    Starts the workflow directly (not via the nightly schedule) so that manual
    triggers work on a fresh Temporal database.
    """
    if not user_id:
        raise HTTPException(status_code=401, detail="user_id is required")

    client = _temporal_client
    if not client:
        raise HTTPException(status_code=503, detail="Temporal client not available")

    try:
        from temporalio.exceptions import WorkflowAlreadyStartedError
        from ci.config import settings

        if _model_exists(user_id):
            from ci.pipeline.nightly_runner import NightlyHBPEWorkflow
            workflow_id = f"{_NIGHTLY_WF_PREFIX}-{user_id[:8]}"
            try:
                handle = await client.start_workflow(
                    NightlyHBPEWorkflow.run,
                    user_id,
                    id=workflow_id,
                    task_queue=settings.task_queue,
                )
                return {"status": "triggered", "workflow": "nightly", "workflow_id": handle.id}
            except WorkflowAlreadyStartedError:
                return {"status": "already_running", "workflow": "nightly", "workflow_id": workflow_id}
        else:
            from ci.pipeline.bootstrap import BootstrapHBPEWorkflow
            workflow_id = f"{_BOOTSTRAP_WF_PREFIX}-{user_id[:8]}"
            try:
                handle = await client.start_workflow(
                    BootstrapHBPEWorkflow.run,
                    user_id,
                    id=workflow_id,
                    task_queue=settings.task_queue,
                )
                return {"status": "triggered", "workflow": "bootstrap", "workflow_id": handle.id}
            except WorkflowAlreadyStartedError:
                return {"status": "already_running", "workflow": "bootstrap", "workflow_id": workflow_id}

    except HTTPException:
        raise
    except Exception as e:
        log.exception("Failed to manually trigger HBPE pipeline")
        raise HTTPException(status_code=500, detail=str(e))

