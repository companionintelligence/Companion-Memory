"""
FastAPI application for HBPE — Hierarchical Behavioral Prediction Engine.

Lifecycle:
  • On startup: load InferenceEngine per user, start EventIngester background task.
  • On shutdown: stop ingester.

Endpoints:
  GET /health               — liveness probe
  GET /histogram            — 96-bucket (15-min) 24h behavioral forecast
  GET /forecast             — week-horizon per-day occurrence forecast
  GET /forecast/due         — renewal ("due"/overdue) predictions for periodic clusters
  GET /forecast/seasonal    — month-of-year occurrence for anchor clusters
  POST /invalidate/{date}   — manual cache invalidation (for testing / admin;
                              404 unless HBPE_ENABLE_ADMIN_ROUTES is set)
  POST /trigger             — manual pipeline run (same switch)

The engine registry maps user_id → InferenceEngine.  In a single-user
deployment (Phase 4 target), the registry has one entry loaded from the DB.
In multi-user mode, engines are created on first request and cached.

Implements T4.4 (CI-Server-k64) and integrates T4.3 ingester.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import date

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

from ci.hbpe.pipeline.histogram_api import build_histogram
from ci.telemetry import init_telemetry

log = logging.getLogger(__name__)

# No-op unless SENTRY_DSN is set — see the ci-telemetry package.
init_telemetry("ci-server-hbpe")

# Global engine registry: user_id → InferenceEngine
_engines: dict = {}
_ingester = None


def _get_or_create_engine(user_id: str):
    if user_id not in _engines:
        from ci.hbpe.pipeline.inference_engine import InferenceEngine

        log.info("Creating InferenceEngine for user %s", user_id[:8])
        _engines[user_id] = InferenceEngine(user_id)
    return _engines[user_id]


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _ingester

    # Init database connection pool early to fail fast
    from ci.hbpe.database import init_db

    init_db()

    # Start event ingester
    from ci.hbpe.pipeline.ingester import EventIngester

    _ingester = EventIngester(_engines)
    await _ingester.start()

    yield

    # Shutdown
    if _ingester:
        await _ingester.stop()


app = FastAPI(
    title="HBPE — Hierarchical Behavioral Prediction Engine",
    version="0.2.0",
    lifespan=lifespan,
)

# pg-boss function runner: POST /functions/run, GET /runs/{id}
from ci.hbpe.auth import (  # noqa: E402
    install_sidecar_auth,
    require_admin_routes,
    require_user_id,
)

install_sidecar_auth(app)

from ci.hbpe.runner import router as _runner_router  # noqa: E402

app.include_router(_runner_router)

from ci.hbpe.forage.api import router as _forage_router  # noqa: E402

app.include_router(_forage_router)


def _active_pipeline_status(uid: str) -> str | None:
    """
    Current step of any running HBPE pipeline for uid, e.g. 'BOOTSTRAP:train'
    or 'NIGHTLY:lora'. None when nothing is running. Backed by the in-process
    function runner (ci.hbpe.functions.CURRENT_STEPS).
    """
    from ci.hbpe.functions import CURRENT_STEPS

    return CURRENT_STEPS.get(uid)


async def _resolve_system_status(user_id: str) -> str:
    """
    Status string for the forecast response.

    A live pipeline step (``NIGHTLY:train``, ``BOOTSTRAP:label``, …) always
    wins so the UI can show progress and ETA even while a previous histogram
    is still being served. Otherwise READY once a checkpoint exists, else
    COLD_START.
    """
    step = _active_pipeline_status(user_id)
    if step:
        return step
    if _model_exists(user_id):
        return "READY"
    return "COLD_START"


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "hbpe",
        "engines": list(_engines.keys()),
    }


@app.get("/histogram")
async def histogram(
    user_id: str | None = Query(None, description="User UUID"),
    horizon: str = Query("24h", description="Forecast window (only '24h' supported)"),
) -> dict:
    """
    Return a 96-bucket (15-minute) 24-hour behavioral forecast.

    Response: { horizon, generated_at, buckets: [...96 items...] }
    Each bucket: { bucket_index, start_time, l0_probs, l1_probs, l2_probs, q10, q50, q90 }
    """
    user_id = require_user_id(user_id)

    try:
        engine = _get_or_create_engine(user_id)
        system_status = await _resolve_system_status(user_id)
        result = build_histogram(
            engine, horizon=horizon, user_id=user_id, system_status=system_status
        )
        return JSONResponse(content=result)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        log.exception("Histogram generation failed")
        raise HTTPException(status_code=500, detail="Internal error") from exc


@app.get("/forecast")
async def forecast(
    user_id: str | None = Query(None, description="User UUID"),
    horizon: str = Query("7d", description="Forecast window (only '7d' supported)"),
    include_today: bool = Query(
        False,
        description="Start the window at today (in the user's timezone) instead of "
        "tomorrow. For calendar surfaces that must render a row for today.",
    ),
    timezone: str | None = Query(
        None,
        description="IANA timezone for calendar-day boundaries (e.g. America/Los_Angeles). "
        "Defaults to UTC when omitted.",
    ),
) -> dict:
    """
    Week-horizon occurrence forecast: for each of the next 7 days, the L1
    clusters likely to occur that day with P(occurs) and daypart tendencies.

    Unlike /histogram (bucket occupancy), this predicts *events*: Bernoulli
    per (day × cluster), driven by the nightly recurrence profiles.

    The window starts tomorrow by default — today is partly elapsed, so its
    occurrence probability is a statement about a day already half-spent.
    `include_today` shifts the window back one day for the schedule grid, whose
    first row is today and would otherwise render empty.
    """
    user_id = require_user_id(user_id)
    if horizon != "7d":
        raise HTTPException(
            status_code=400, detail=f"Unsupported horizon '{horizon}'. Supported: 7d"
        )

    import datetime
    from zoneinfo import ZoneInfo

    from ci.hbpe.pipeline.recurrence import log_occurrence_forecast, week_forecast

    try:
        try:
            tz = ZoneInfo(timezone) if timezone else datetime.UTC
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"Invalid timezone: {timezone}"
            ) from exc
        now = datetime.datetime.now(tz)
        today = now.date()
        start = today if include_today else today + datetime.timedelta(days=1)
        days = week_forecast(user_id, days=7, start=start)

        # Only log days that are still wholly in the future. Scoring a partly
        # elapsed day against an occurrence prediction issued mid-day would bias
        # the reliability curve (CI-Server-h0m), so today never enters the log.
        loggable = [d for d in days if d["date"] > today.isoformat()]
        log_occurrence_forecast(
            user_id, loggable, predicted_at=now.astimezone(datetime.UTC)
        )

        return {
            "horizon": horizon,
            # `now` is timezone-aware (tz is always a real ZoneInfo/UTC), so
            # isoformat() already appends the correct offset — a literal "Z"
            # here would double up (e.g. `...+00:00Z`), which JS's Date()
            # rejects as invalid.
            "generated_at": now.isoformat(),
            "days": days,
        }
    except Exception as exc:
        log.exception("Week forecast failed")
        raise HTTPException(status_code=500, detail="Internal error") from exc


@app.get("/forecast/due")
async def forecast_due(
    user_id: str | None = Query(None, description="User UUID"),
) -> dict:
    """
    Renewal predictions for periodic clusters: what's coming due, in how many
    days, and what's overdue (past its p90 inter-arrival gap) — the
    month-horizon "haircut due in 6±4 days / it's been 16 days since you saw
    friends" view.
    """
    user_id = require_user_id(user_id)

    import datetime

    from ci.hbpe.pipeline.recurrence import due_list

    try:
        return {
            "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
            "due": due_list(user_id),
        }
    except Exception as exc:
        log.exception("Due list failed")
        raise HTTPException(status_code=500, detail="Internal error") from exc


@app.get("/forecast/seasonal")
async def forecast_seasonal(
    user_id: str | None = Query(None, description="User UUID"),
) -> dict:
    """Month-of-year occurrence shape for anchor clusters with multi-year evidence."""
    user_id = require_user_id(user_id)

    import datetime

    from ci.hbpe.pipeline.seasonal import seasonal_forecast

    try:
        return {
            "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
            "clusters": seasonal_forecast(user_id),
        }
    except Exception as exc:
        log.exception("Seasonal forecast failed")
        raise HTTPException(status_code=500, detail="Internal error") from exc


@app.post("/invalidate/{date_str}", dependencies=[Depends(require_admin_routes)])
async def invalidate_cache(
    date_str: str,
    user_id: str | None = Query(None, description="User UUID"),
) -> dict:
    """
    Manually invalidate the inference cache for a specific date.
    Useful for admin tooling and integration tests. 404 unless
    HBPE_ENABLE_ADMIN_ROUTES is set (see ``require_admin_routes``).
    """
    user_id = require_user_id(user_id)

    try:
        d = date.fromisoformat(date_str)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"Invalid date: {date_str}"
        ) from exc

    if user_id in _engines:
        _engines[user_id].invalidate(d)
        return {"invalidated": str(d), "user_id": user_id}
    return {"invalidated": str(d), "user_id": user_id, "note": "no engine loaded"}


def _model_exists(user_id: str) -> bool:
    """Return True if this user has an HMT checkpoint and predictions can be served."""
    from ci.hbpe.model.checkpoints import model_exists

    return model_exists(user_id)


@app.post("/trigger", dependencies=[Depends(require_admin_routes)])
async def trigger_pipeline(
    user_id: str | None = Query(None, description="User UUID"),
) -> dict:
    """
    Manually trigger the HBPE pipeline for the user (background run on the
    in-process function runner; poll GET /runs/{run_id} for progress).
    404 unless HBPE_ENABLE_ADMIN_ROUTES is set: the API starts runs through
    /functions/run, and this route would start one for any user_id.

    Cold start (no checkpoint): runs the full bootstrap pipeline from labeling
    through model training, calibration, and ONNX export.

    Warm start (checkpoint exists): runs the nightly incremental
    label/sweep/LoRA update.
    """
    user_id = require_user_id(user_id)

    from ci.hbpe.runner import RunRequest, runner

    pipeline = "nightly" if _model_exists(user_id) else "bootstrap"

    if _active_pipeline_status(user_id):
        return {"status": "already_running", "workflow": pipeline}

    try:
        record = runner.submit(RunRequest(function=pipeline, args={"user_id": user_id}))

        return {
            "status": "triggered",
            "workflow": pipeline,
            "run_id": record.run_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Failed to manually trigger HBPE pipeline")
        raise HTTPException(status_code=500, detail=str(e)) from e
