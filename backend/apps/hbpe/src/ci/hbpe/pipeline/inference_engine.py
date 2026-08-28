"""
Incremental inference engine for the HMT model (T4.2).

Produces 48-bucket (30-minute) behavioral forecasts by aggregating
per-day model outputs across a 30-day sliding window, weighted by recency
and day-of-week similarity to the forecast horizon.

"KV-cache" semantics for an encoder-only model
─────────────────────────────────────────────
A bidirectional encoder recomputes every position on every forward pass —
true per-layer key/value caching (as in autoregressive decoders) would
require converting the architecture.  Instead we memoize full per-day model
outputs (the encoder's final per-token logits).  This gives the same latency
savings: when a new event arrives only the affected day's entry is evicted and
recomputed; all other days remain cached.

Per-day output:
  _output_cache[date] = {
      "l0": {bucket_idx → float32 array(V_l0)},   # L0 logits per bucket
      "l1": {bucket_idx → float32 array(V_l1)},   # L1 logits per bucket
  }

Aggregate for histogram
  For each future bucket b:
    l0_probs[b] = Σ_d  w_d * softmax(l0_logits_d[b] / T)
  where  w_d = recency(λ=7) × DoW×2 × month boost × metric coverage weight,
  then a daypart HMM smoother, then the D3 serve gate (hmt vs b1 vs b2).

Implements T4.2 (CI-Server-04d).
"""

from __future__ import annotations

import datetime
import logging
from pathlib import Path

import numpy as np

from ci.hbpe.buckets import BUCKET_MINUTES
from ci.hbpe.buckets import BUCKETS_PER_DAY as N_BUCKETS
from ci.hbpe.model.calibration import _build_full_batch
from ci.hbpe.model.checkpoints import (
    HMT_CALIBRATED,
    HMT_CKPT,
    HMT_FP32_ONNX,
    HMT_INT8_ONNX,
    MODEL_ARTIFACTS,
    int8_is_servable,
    user_ckpt_dir,
)
from ci.hbpe.model.vocab import (
    EOD_IDX,
    L0_CLASSES,
    PAD_IDX,
    SOD_IDX,
    build_l0_vocab,
    build_l1_vocab,
)
from ci.hbpe.pipeline.baselines import (
    _as_date,
    b1_probs,
    b2_day_emissions,
    count_history_days,
    occupancy_counts,
)
from ci.hbpe.pipeline.hmm import (
    apply_class_priors,
    forward_backward,
    laplace_transitions,
)
from ci.hbpe.pipeline.kernel import kernel_weight
from ci.hbpe.pipeline.metric_lifts import (
    COLD_START_MIN_DAYS,
    HOME_MEDIAN_FALLBACK,
    SLEEP_MEDIAN_FALLBACK,
    coverage_ok,
    day_coverage_weight,
    fetch_metric_rows,
    median,
    priors_matrix,
)
from ci.hbpe.pipeline.serve import (
    MODEL_B1,
    MODEL_B2,
    MODEL_HMT,
    pick_served_model,
)

log = logging.getLogger(__name__)

WINDOW_DAYS = 30
MIN_TRAIN_DAYS = 16  # TEST_DAYS + 2; below this, serve B1 instead of a uniform prior
N_SPECIAL = 4

_SPECIAL_IDX = {PAD_IDX, SOD_IDX, EOD_IDX}


def _onnx_pos_emb_dims(path: Path) -> tuple[int, int] | None:
    """Return (rows, width) of ``pos_emb.weight`` in an ONNX graph, if present."""
    try:
        import onnx
    except ImportError:
        return None
    model = onnx.load(str(path), load_external_data=False)
    for init in model.graph.initializer:
        if init.name == "pos_emb.weight" or init.name.endswith("/pos_emb.weight"):
            if init.dims and len(init.dims) >= 2:
                return int(init.dims[0]), int(init.dims[1])
            if init.dims:
                return int(init.dims[0]), -1
    return None


def _onnx_pos_emb_rows(path: Path) -> int | None:
    """Return the first dim of ``pos_emb.weight`` in an ONNX graph, if present."""
    dims = _onnx_pos_emb_dims(path)
    return None if dims is None else dims[0]


def _assert_checkpoint_bucket_resolution(path: Path) -> None:
    """
    Reject ONNX checkpoints whose bucket position table does not match
    ``BUCKETS_PER_DAY``.

    Without this, a 96-row (15-min) embedding table loads fine under a 48-bucket
    (30-min) runtime and silently maps morning slots onto the wrong wall-clock
    hours.
    """
    dims = _onnx_pos_emb_dims(path)
    if dims is None:
        return
    rows, width = dims
    if rows != N_BUCKETS:
        raise ValueError(
            f"{path.name} pos_emb has {rows} rows; expected {N_BUCKETS} "
            f"for {BUCKET_MINUTES}-minute buckets — re-export after retrain"
        )
    from ci.hbpe.model.transformer import D_MODEL

    if width > 0 and width != D_MODEL:
        raise ValueError(
            f"{path.name} pos_emb width {width} != D_MODEL {D_MODEL} — "
            "retrain; refusing to serve a mismatched architecture"
        )


# ── PyTorch fallback session ───────────────────────────────────────────────────


class _PyTorchSession:
    """Wraps HMTModel with the same run() interface as onnxruntime.InferenceSession."""

    def __init__(self, model) -> None:
        self._model = model

    def run(self, _output_names, inputs: dict) -> tuple[np.ndarray, np.ndarray]:
        import torch

        with torch.no_grad():
            t = torch.from_numpy(inputs["token_ids"])
            b = torch.from_numpy(inputs["bucket_idxs"])
            lv = torch.from_numpy(inputs["level_ids"])
            pm = torch.from_numpy(inputs["padding_mask"])
            l0_logits, l1_logits = self._model(t, b, lv, pm)
        return l0_logits.numpy(), l1_logits.numpy()


# ── Inference engine ───────────────────────────────────────────────────────────


class InferenceEngine:
    """
    Caching inference engine for HMT behavioral forecasting.

    Lifecycle:
      engine = InferenceEngine(user_id)
      buckets = engine.predict(horizon_start=datetime.utcnow())

      # On new event:
      engine.invalidate(date.today())

      # After nightly LoRA update:
      engine.invalidate_all()
    """

    def __init__(self, user_id: str, device: str = "cpu") -> None:
        self.user_id = user_id
        self.device = device
        self._l0_vocab = build_l0_vocab()
        self._l1_vocab = build_l1_vocab(user_id)
        self._l1_display_names: dict[str, str] = self._load_l1_display_names()
        self._onnx_seq_len: int | None = None
        self._l1_dim: int | None = None  # model's L1 output width
        self._session_path: Path | None = None
        self._session_mtime: float | None = None
        self._session = self._load_session()
        self._temp = self._load_temperature()
        # Memoised per-day model outputs
        self._output_cache: dict[datetime.date, dict | None] = {}
        self._occupancy: list[dict] | None = None
        self._l1_l0: dict[str, str] = self._load_l1_l0()
        self.last_model_version = MODEL_HMT
        self.last_still_learning = False

    def _load_l1_display_names(self) -> dict[str, str]:
        """Load cluster_id → human-readable label mapping for L1 labels."""
        from ci.hbpe.database import get_conn

        try:
            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT cluster_id::text, label FROM hbpe.l1_clusters WHERE user_id = %s",
                        (self.user_id,),
                    )
                    return {
                        row[0]: row[1].replace("_", " ").title()
                        for row in cur.fetchall()
                    }
        except Exception as exc:
            log.warning("Could not load L1 display names: %s", exc)
            return {}

    def _load_l1_l0(self) -> dict[str, str]:
        """cluster UUID and display name → L0 class, for conditional L1 decode."""
        from ci.hbpe.database import get_conn

        try:
            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT cluster_id::text, label, l0_class
                        FROM hbpe.l1_clusters WHERE user_id = %s
                        """,
                        (self.user_id,),
                    )
                    mapping: dict[str, str] = {}
                    for cid, label, l0 in cur.fetchall():
                        mapping[cid] = l0
                        mapping[cid[:8]] = l0
                        if label:
                            mapping[label.replace("_", " ").title()] = l0
                    return mapping
        except Exception as exc:
            log.warning("Could not load L1→L0 map: %s", exc)
            return {}

    def _refresh_vocab(self) -> None:
        """Rebuild the L1 vocab + display names to match a freshly (re)loaded
        model.

        The model's L1 output width is fixed at export/train time. A cached
        engine builds its vocab once in __init__; if it was created when fewer
        clusters existed, that vocab stays stale even after the nightly pipeline
        rewrites the model with a larger vocab — so predict() would aggregate a
        stale-width array against the new model output and raise a numpy
        broadcast error (HTTP 400). Refreshing on every session (re)load keeps
        the vocab and cluster-name decoding in lockstep with the model.
        """
        self._l1_vocab = build_l1_vocab(self.user_id)
        self._l1_display_names = self._load_l1_display_names()
        self._l1_l0 = self._load_l1_l0()

    # ── Session loading ────────────────────────────────────────────────────────

    def _load_session(self):
        """Load INT8 ONNX → FP32 ONNX → PyTorch model (in preference order).

        INT8 is skipped unless the last export report has ``delta_passed: true``.
        ONNX graphs whose embedding width doesn't match the running D_MODEL are
        refused so a 64-d toy checkpoint cannot keep serving after a 256-d bump.
        """
        ckpt_dir = user_ckpt_dir(self.user_id)
        int8_path = ckpt_dir / HMT_INT8_ONNX
        fp32_path = ckpt_dir / HMT_FP32_ONNX
        onnx_candidates: list = []
        if int8_path.exists() and int8_is_servable(self.user_id):
            onnx_candidates.append(int8_path)
        elif int8_path.exists():
            log.warning(
                "Skipping INT8 ONNX for %s: export delta did not pass",
                self.user_id[:8],
            )
        if fp32_path.exists():
            onnx_candidates.append(fp32_path)
        for path in onnx_candidates:
            if path.exists():
                try:
                    import onnxruntime as ort

                    from ci.hbpe.model.onnx_export import ONNX_SEQ_LEN

                    _assert_checkpoint_bucket_resolution(path)
                    sess = ort.InferenceSession(str(path))
                    # After INT8 static quantization the sequence dimension may be
                    # represented as a dynamic string rather than a fixed int.
                    # Always fall back to the exported constant so padding is applied.
                    input_shape = sess.get_inputs()[0].shape
                    if len(input_shape) >= 2 and isinstance(input_shape[1], int):
                        self._onnx_seq_len = input_shape[1]
                    else:
                        self._onnx_seq_len = ONNX_SEQ_LEN
                    # Capture the model's L1 output width so predict() sizes its
                    # aggregation to the model, never a possibly-stale vocab.
                    self._l1_dim = next(
                        (
                            o.shape[-1]
                            for o in sess.get_outputs()
                            if o.name == "l1_logits"
                            and o.shape
                            and isinstance(o.shape[-1], int)
                        ),
                        None,
                    )
                    self._session_path = path
                    self._session_mtime = path.stat().st_mtime
                    log.info(
                        "Inference engine using ONNX: %s  (seq_len=%d)",
                        path.name,
                        self._onnx_seq_len,
                    )
                    return sess
                except Exception as exc:
                    log.warning(
                        "ONNX load failed (%s): %s — falling back", path.name, exc
                    )

        # PyTorch fallback
        try:
            from ci.hbpe.model.evaluator import _load_calibrated
            from ci.hbpe.model.lora import load_adapter, merge_adapter

            model, _ = _load_calibrated(
                self.user_id, self._l0_vocab, self._l1_vocab, self.device
            )
            adapter_path = ckpt_dir / f"lora_{self.user_id}.pt"
            if adapter_path.exists():
                load_adapter(model, adapter_path)
                merge_adapter(model)
            model.eval()
            # The PyTorch model is built from the current vocab, so its L1 width
            # matches len(self._l1_vocab).
            self._l1_dim = len(self._l1_vocab)
            # Track calibrated checkpoint for mtime-based hot reload.
            calibrated_path = ckpt_dir / HMT_CALIBRATED
            if calibrated_path.exists():
                self._session_path = calibrated_path
                self._session_mtime = calibrated_path.stat().st_mtime
            log.info("Inference engine using PyTorch fallback")
            return _PyTorchSession(model)
        except FileNotFoundError:
            log.warning(
                "No checkpoint found for PyTorch fallback; engine will start in dry-run mode until pipeline completes"
            )
            return None
        except Exception as exc:
            log.warning("PyTorch fallback load failed: %s — returning None", exc)
            return None

    def _load_temperature(self) -> float:
        import torch

        ckpt_dir = user_ckpt_dir(self.user_id)
        for name in (HMT_CALIBRATED, HMT_CKPT):
            p = ckpt_dir / name
            if p.exists():
                ckpt = torch.load(p, map_location="cpu", weights_only=True)
                return float(ckpt.get("temperature", 1.0))
        return 1.0

    # ── Day-level inference ────────────────────────────────────────────────────

    def _run_day(self, day_tokens: list[dict]) -> dict | None:
        """
        Run the model on one day's token list.
        Returns {"l0": {bucket → logit_array}, "l1": {bucket → logit_array}}
        or None if the day has no usable data.
        """
        batch = _build_full_batch(day_tokens, self._l0_vocab, self._l1_vocab, "cpu")
        if batch is None or self._session is None:
            return None

        token_ids, bucket_idxs, level_ids, padding_mask, _, _ = batch
        seq_len = int(token_ids.shape[1])
        if self._onnx_seq_len is not None:
            if seq_len > self._onnx_seq_len:
                # Keep the most recent tokens (token_stream is ordered by seq_order
                # ascending, so tail = newest buckets in the day). A single overflowing
                # day must not take the whole 30-day forecast offline.
                overflow = seq_len - self._onnx_seq_len
                log.warning(
                    "Day token count %d exceeds ONNX width %d — truncating %d oldest tokens",
                    seq_len,
                    self._onnx_seq_len,
                    overflow,
                )
                token_ids = token_ids[:, overflow:]
                bucket_idxs = bucket_idxs[:, overflow:]
                level_ids = level_ids[:, overflow:]
                padding_mask = padding_mask[:, overflow:]
                seq_len = self._onnx_seq_len

            pad = self._onnx_seq_len - seq_len
            if pad > 0:
                token_np = np.pad(
                    token_ids.numpy().astype(np.int64),
                    ((0, 0), (0, pad)),
                    constant_values=PAD_IDX,
                )
                bucket_np = np.pad(
                    bucket_idxs.numpy().astype(np.int64),
                    ((0, 0), (0, pad)),
                    constant_values=0,
                )
                level_np = np.pad(
                    level_ids.numpy().astype(np.int64),
                    ((0, 0), (0, pad)),
                    constant_values=0,
                )
                mask_np = np.pad(
                    padding_mask.numpy().astype(bool),
                    ((0, 0), (0, pad)),
                    constant_values=True,
                )
            else:
                token_np = token_ids.numpy().astype(np.int64)
                bucket_np = bucket_idxs.numpy().astype(np.int64)
                level_np = level_ids.numpy().astype(np.int64)
                mask_np = padding_mask.numpy().astype(bool)
        else:
            token_np = token_ids.numpy().astype(np.int64)
            bucket_np = bucket_idxs.numpy().astype(np.int64)
            level_np = level_ids.numpy().astype(np.int64)
            mask_np = padding_mask.numpy().astype(bool)

        ort_in = {
            "token_ids": token_np,
            "bucket_idxs": bucket_np,
            "level_ids": level_np,
            "padding_mask": mask_np,
        }
        l0_np, l1_np = self._session.run(["l0_logits", "l1_logits"], ort_in)

        bucket_l0: dict[int, np.ndarray] = {}
        bucket_l1: dict[int, np.ndarray] = {}
        T = token_ids.shape[1]
        for i in range(T):
            b = int(bucket_idxs[0, i])
            lvl = int(level_ids[0, i])
            if lvl == 0:
                bucket_l0[b] = l0_np[0, i, :]
            else:
                bucket_l1[b] = l1_np[0, i, :]

        return {"l0": bucket_l0, "l1": bucket_l1}

    def _fetch_day_tokens(self, date: datetime.date) -> list[dict]:
        """Fetch one day's token stream from ci.token_stream."""
        import psycopg2.extras

        from ci.hbpe.database import get_conn

        with get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT level, token_id, bucket_idx, soft_prob
                    FROM hbpe.token_stream
                    WHERE user_id = %s AND date = %s
                    ORDER BY seq_order
                    """,
                    (self.user_id, date),
                )
                return [dict(r) for r in cur.fetchall()]

    def _get_day_output(self, date: datetime.date) -> dict | None:
        """Return (possibly cached) per-bucket logits for *date*."""
        if date not in self._output_cache:
            tokens = self._fetch_day_tokens(date)
            self._output_cache[date] = self._run_day(tokens) if tokens else None
        return self._output_cache[date]

    # ── Public API ─────────────────────────────────────────────────────────────

    def _try_reload_session(self) -> None:
        """Reload model session if we're in dry-run mode and a checkpoint now exists."""
        ckpt_dir = user_ckpt_dir(self.user_id)
        checkpoint_exists = any((ckpt_dir / name).exists() for name in MODEL_ARTIFACTS)
        if not checkpoint_exists:
            return
        session = self._load_session()
        if session is not None:
            self._session = session
            self._refresh_vocab()
            self._temp = self._load_temperature()
            self.invalidate_all()
            log.info("Inference engine reloaded from checkpoint (was in dry-run mode)")

    def _reload_if_model_changed(self) -> None:
        """
        Detect when the nightly/bootstrap pipeline has rewritten the model file
        and swap in the new session. Without this the cached engine keeps using
        a stale ONNX checkpoint (and stale onnx_seq_len / temperature) forever.
        """
        if self._session_path is None:
            return
        if not self._session_path.exists():
            # File was deleted (e.g. DB reset). Drop session; next predict() will
            # call _try_reload_session.
            self._session = None
            self._session_mtime = None
            self.invalidate_all()
            return
        try:
            current_mtime = self._session_path.stat().st_mtime
        except OSError:
            return
        if self._session_mtime is not None and current_mtime > self._session_mtime:
            log.info("Model file mtime changed — reloading inference session")
            self._onnx_seq_len = None
            new_session = self._load_session()
            if new_session is not None:
                self._session = new_session
                self._refresh_vocab()
                self._temp = self._load_temperature()
                self.invalidate_all()

    def predict(
        self,
        horizon_start: datetime.datetime | None = None,
        as_of: datetime.date | None = None,
        force_model: str | None = None,
    ) -> list[dict]:
        """
        Return a 48-bucket histogram for the 24h window starting at *horizon_start*
        (default: midnight tonight).

        Each element: {bucket_index, start_time, l0_probs, l1_probs, l2_probs,
                       q10, q50, q90}

        ``as_of`` walks the history window from that date (nightly HMT scoring).
        ``force_model`` skips D3 (``hmt`` / ``b1`` / ``b2``).
        """
        if self._session is None:
            self._try_reload_session()
        else:
            self._reload_if_model_changed()

        if horizon_start is None:
            now = datetime.datetime.utcnow()
            horizon_start = datetime.datetime(
                now.year, now.month, now.day
            ) + datetime.timedelta(days=1)

        forecast_date = horizon_start.date()
        as_of = as_of or datetime.date.today()

        occupancy = self._get_occupancy()
        n_hist_days = count_history_days(occupancy)
        distinct_years = (
            len({_as_date(r["date"]).year for r in occupancy}) if occupancy else 0
        )
        has_ckpt = self._session is not None
        still_learning = (not has_ckpt) or n_hist_days < MIN_TRAIN_DAYS

        metric_start = as_of - datetime.timedelta(
            days=WINDOW_DAYS + COLD_START_MIN_DAYS
        )
        metric_rows = fetch_metric_rows(self.user_id, metric_start, as_of)
        metrics_by_date = {}
        for row in metric_rows:
            d = row["date"]
            metrics_by_date[d] = row
        floor_cleared = coverage_ok(metric_rows)
        sleep_med = median(
            [
                float(r["sleep_minutes"])
                for r in metric_rows
                if r.get("sleep_minutes") is not None
            ],
            SLEEP_MEDIAN_FALLBACK,
        )
        home_med = median(
            [
                float(r["time_at_home"])
                for r in metric_rows
                if r.get("time_at_home") is not None
            ],
            HOME_MEDIAN_FALLBACK,
        )

        V_l0 = len(self._l0_vocab)
        V_l1 = self._l1_dim or len(self._l1_vocab)
        bucket_l0_sum = np.zeros((N_BUCKETS, V_l0), dtype=np.float64)
        bucket_l1_sum = np.zeros((N_BUCKETS, V_l1), dtype=np.float64)
        bucket_weight = np.zeros(N_BUCKETS, dtype=np.float64)
        bucket_conf_samples: list[list[float]] = [[] for _ in range(N_BUCKETS)]

        hmt_days = 0
        if has_ckpt:
            for i in range(WINDOW_DAYS):
                hist_date = as_of - datetime.timedelta(days=i + 1)
                day_out = self._get_day_output(hist_date)
                if day_out is None:
                    continue
                hmt_days += 1
                w = kernel_weight(
                    i,
                    hist_date,
                    forecast_date,
                    distinct_years,
                    day_coverage_weight(metrics_by_date.get(hist_date), floor_cleared),
                )
                for b in range(N_BUCKETS):
                    if b in day_out["l0"]:
                        probs = _softmax(day_out["l0"][b] / self._temp)
                        bucket_l0_sum[b] += w * probs
                        bucket_weight[b] += w
                        bucket_conf_samples[b].append(float(probs.max()))
                    if b in day_out["l1"]:
                        bucket_l1_sum[b] += w * _softmax(day_out["l1"][b] / self._temp)

            for b in range(N_BUCKETS):
                if bucket_weight[b] > 0:
                    bucket_l0_sum[b] /= bucket_weight[b]
                    bucket_l1_sum[b] /= bucket_weight[b]
                else:
                    bucket_l0_sum[b] = np.ones(V_l0) / V_l0

        # 8-class slice + metric class priors + HMM
        l0_classes = list(L0_CLASSES)
        hmt_emissions = np.zeros((N_BUCKETS, 8), dtype=np.float64)
        for b in range(N_BUCKETS):
            class_arr = (
                bucket_l0_sum[b, N_SPECIAL:].copy()
                if V_l0 > N_SPECIAL
                else np.ones(8) / 8
            )
            if class_arr.shape[0] < 8:
                padded = np.ones(8) / 8
                padded[: class_arr.shape[0]] = class_arr
                class_arr = padded
            tot = class_arr[:8].sum()
            hmt_emissions[b] = class_arr[:8] / tot if tot > 0 else np.ones(8) / 8

        until = forecast_date
        _b0_counts, b1_counts, trans_counts = occupancy_counts(occupancy, until=until)
        transitions = laplace_transitions(trans_counts)
        dow = forecast_date.weekday()
        b1_em = np.stack(
            [_probs_to_arr(b1_probs(b1_counts, b, dow)) for b in range(N_BUCKETS)]
        )
        b2_em = b2_day_emissions(b1_counts, trans_counts, dow)

        forecast_metrics = metrics_by_date.get(as_of - datetime.timedelta(days=1))
        sleep_v = (
            float(forecast_metrics["sleep_minutes"])
            if forecast_metrics and forecast_metrics.get("sleep_minutes") is not None
            else None
        )
        home_v = (
            float(forecast_metrics["time_at_home"])
            if forecast_metrics and forecast_metrics.get("time_at_home") is not None
            else None
        )
        priors = np.asarray(
            priors_matrix(
                N_BUCKETS, sleep_v, home_v, sleep_med, home_med, floor_cleared
            ),
            dtype=np.float64,
        )
        hmt_emissions = apply_class_priors(hmt_emissions, priors)
        b1_em = apply_class_priors(b1_em, priors)
        b2_em = apply_class_priors(b2_em, priors)

        hmt_smooth = forward_backward(hmt_emissions, transitions, n_buckets=N_BUCKETS)
        b1_smooth = forward_backward(b1_em, transitions, n_buckets=N_BUCKETS)
        b2_smooth = forward_backward(b2_em, transitions, n_buckets=N_BUCKETS)

        if force_model:
            served = force_model
        elif still_learning:
            served = MODEL_B1 if n_hist_days > 0 else MODEL_B2
        else:
            from ci.hbpe.pipeline.scoring import fetch_latest_by_version

            scores = fetch_latest_by_version(self.user_id)
            served = pick_served_model(
                scores.get(MODEL_HMT),
                scores.get(MODEL_B1),
                scores.get(MODEL_B2),
                has_checkpoint=has_ckpt and hmt_days > 0,
            )

        if served == MODEL_HMT and hmt_days == 0:
            served = MODEL_B1 if n_hist_days > 0 else MODEL_B2

        emissions = {
            MODEL_HMT: hmt_smooth,
            MODEL_B1: b1_smooth,
            MODEL_B2: b2_smooth,
        }.get(served, b1_smooth)
        self.last_model_version = served
        self.last_still_learning = still_learning and served != MODEL_HMT

        results: list[dict] = []
        for b in range(N_BUCKETS):
            start_time = horizon_start + datetime.timedelta(minutes=BUCKET_MINUTES * b)
            class_arr = emissions[b]
            l0_probs = {cls: float(class_arr[i]) for i, cls in enumerate(l0_classes)}
            predicted_l0 = l0_classes[int(np.argmax(class_arr))]
            l1_probs = self._decode_l1(bucket_l1_sum[b], predicted_l0)
            samples = bucket_conf_samples[b]
            q10, q50, q90 = _quantiles(samples) if samples else (0.0, 0.0, 0.0)
            results.append(
                {
                    "bucket_index": b,
                    "start_time": start_time.isoformat() + "Z",
                    "l0_probs": l0_probs,
                    "l1_probs": l1_probs,
                    "l2_probs": {},
                    "q10": q10,
                    "q50": q50,
                    "q90": q90,
                }
            )
        return results

    def _get_occupancy(self) -> list[dict]:
        if self._occupancy is None:
            try:
                from ci.hbpe.pipeline.baselines import fetch_occupancy_rows

                self._occupancy = fetch_occupancy_rows(self.user_id)
            except Exception as exc:
                log.info("occupancy fetch skipped: %s", exc)
                self._occupancy = []
        return self._occupancy

    def _decode_l1(self, l1_arr: np.ndarray, predicted_l0: str) -> dict[str, float]:
        if l1_arr.size == 0:
            return {}
        top_idx = np.argsort(l1_arr)[::-1]
        raw: dict[str, float] = {}
        for idx in top_idx:
            if l1_arr[idx] <= 1e-6:
                continue
            uuid = self._l1_vocab.decode(int(idx))
            name = self._l1_display_names.get(uuid, uuid[:8])
            l0 = self._l1_l0.get(uuid) or self._l1_l0.get(name)
            if l0 and l0 != predicted_l0:
                continue
            raw[name] = float(l1_arr[idx])
            if len(raw) >= 10:
                break
        total = sum(raw.values())
        if total <= 0:
            return {}
        return {k: v / total for k, v in raw.items()}

    def invalidate(self, date: datetime.date) -> None:
        """Evict one day from the output cache (call on new event arrival)."""
        self._output_cache.pop(date, None)
        self._occupancy = None
        log.debug("Cache invalidated for %s", date)

    def invalidate_all(self) -> None:
        """Clear the entire cache (call after LoRA adapter update)."""
        self._output_cache.clear()
        self._occupancy = None
        log.info("Inference cache cleared (full invalidation)")


# ── Helpers ────────────────────────────────────────────────────────────────────


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max())
    return e / e.sum()


def _probs_to_arr(probs: dict[str, float]) -> np.ndarray:
    return np.array([float(probs.get(c, 0.0)) for c in L0_CLASSES], dtype=np.float64)


def _quantiles(values: list[float]) -> tuple[float, float, float]:
    a = np.array(values)
    return (
        float(np.percentile(a, 10)),
        float(np.percentile(a, 50)),
        float(np.percentile(a, 90)),
    )
