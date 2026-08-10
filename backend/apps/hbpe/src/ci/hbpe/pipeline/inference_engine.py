"""
Incremental inference engine for the HMT model (T4.2).

Produces 96-bucket (15-minute) behavioral forecasts by aggregating
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
    l0_potentials[b][c] = Σ_d  w_d * sigmoid(l0_logit_d[b,c] / T)
  Each L0 class is an independent 0–1 energy potential (if you'd done nothing
  else in that slot). Potentials do NOT sum to 100%. The occupant (most probable
  class) wins for bucket display; q10/q50/q90 measure how predictable that time
  range is from historical consistency.

Implements T4.2 (CI-Server-04d).
"""

from __future__ import annotations

import datetime
import logging
from pathlib import Path

import numpy as np

from ci.hbpe.buckets import (
    BUCKET_MINUTES,
    detect_legacy_token_stream,
    legacy_hist_to_forecast_buckets,
)
from ci.hbpe.buckets import BUCKETS_PER_DAY as N_BUCKETS
from ci.hbpe.model.calibration import _build_full_batch
from ci.hbpe.model.checkpoints import (
    HMT_CALIBRATED,
    HMT_CKPT,
    HMT_FP32_ONNX,
    HMT_INT8_ONNX,
    MODEL_ARTIFACTS,
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

log = logging.getLogger(__name__)

WINDOW_DAYS = 30
DECAY_LAMBDA = 7.0  # recency half-life in days
DOW_BOOST = 2.0  # weight multiplier for same-day-of-week as forecast

_SPECIAL_IDX = {PAD_IDX, SOD_IDX, EOD_IDX}
N_SPECIAL = 4  # PAD, MASK, SOD, EOD precede the 8 behavioral L0 classes


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
        self._l0_transition: np.ndarray | None = None

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

    # ── Session loading ────────────────────────────────────────────────────────

    def _load_session(self):
        """Load INT8 ONNX → FP32 ONNX → PyTorch model (in preference order)."""
        ckpt_dir = user_ckpt_dir(self.user_id)
        int8_path = ckpt_dir / HMT_INT8_ONNX
        fp32_path = ckpt_dir / HMT_FP32_ONNX
        for path in (int8_path, fp32_path):
            if path.exists():
                try:
                    import onnxruntime as ort

                    from ci.hbpe.model.onnx_export import ONNX_SEQ_LEN

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
            if not tokens:
                self._output_cache[date] = None
            else:
                legacy = detect_legacy_token_stream(tokens)
                day_out = self._run_day(tokens)
                if day_out is None:
                    self._output_cache[date] = None
                else:
                    day_out["legacy"] = legacy
                    self._output_cache[date] = day_out
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

    def predict(self, horizon_start: datetime.datetime | None = None) -> list[dict]:
        """
        Return a 96-bucket histogram for the 24h window starting at *horizon_start*
        (default: midnight tonight).

        Each element: {bucket_index, start_time, l0_probs, occupant_l0,
                       l0_predictability, l1_probs, l2_probs, q10, q50, q90}

        l0_probs holds independent 0–1 energy potentials per class (need not sum
        to 1). occupant_l0 is the highest-potential class for the bucket.
        q10/q50/q90 measure how predictable this time range is historically.
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
        today = datetime.date.today()

        # ── Aggregate per-bucket logits from recent days ──────────────────────
        # Size the L1 aggregation to the model's actual output width (falling
        # back to the vocab length), so a vocab that has drifted from the loaded
        # model can never cause a numpy broadcast error. Out-of-range indices
        # decode to the PAD token, so a slightly stale vocab degrades gracefully.
        V_l0 = len(self._l0_vocab)
        V_l1 = self._l1_dim or len(self._l1_vocab)

        bucket_l0_sum = np.zeros((N_BUCKETS, V_l0), dtype=np.float64)
        bucket_l1_sum = np.zeros((N_BUCKETS, V_l1), dtype=np.float64)
        bucket_weight = np.zeros(N_BUCKETS, dtype=np.float64)
        # Per-class historical potential samples for range-time predictability.
        bucket_class_samples: list[list[list[float]]] = [
            [[] for _ in range(len(L0_CLASSES))] for _ in range(N_BUCKETS)
        ]
        # Historical max-potential per bucket (overall slot predictability).
        bucket_max_potential_samples: list[list[float]] = [[] for _ in range(N_BUCKETS)]

        forecast_dow = forecast_date.weekday()

        for i in range(WINDOW_DAYS):
            hist_date = today - datetime.timedelta(days=i + 1)
            day_out = self._get_day_output(hist_date)
            if day_out is None:
                continue

            w_recency = np.exp(-i / DECAY_LAMBDA)
            w_dow = DOW_BOOST if hist_date.weekday() == forecast_dow else 1.0
            w = w_recency * w_dow
            legacy = day_out.get("legacy", False)

            for hist_bucket, l0_logits in day_out["l0"].items():
                forecast_buckets = (
                    legacy_hist_to_forecast_buckets(hist_bucket)
                    if legacy
                    else [hist_bucket]
                )
                share = 1.0 / len(forecast_buckets)
                potentials = _logits_to_potentials(l0_logits, self._temp, V_l0)
                for b in forecast_buckets:
                    if b >= N_BUCKETS:
                        continue
                    bucket_l0_sum[b] += share * w * potentials
                    bucket_weight[b] += share * w
                    for ci, val in enumerate(potentials[N_SPECIAL:]):
                        bucket_class_samples[b][ci].append(float(val))
                    bucket_max_potential_samples[b].append(
                        float(potentials[N_SPECIAL:].max())
                    )

            for hist_bucket, l1_logits in day_out["l1"].items():
                forecast_buckets = (
                    legacy_hist_to_forecast_buckets(hist_bucket)
                    if legacy
                    else [hist_bucket]
                )
                share = 1.0 / len(forecast_buckets)
                l1_probs = _softmax(l1_logits / self._temp)
                for b in forecast_buckets:
                    if b >= N_BUCKETS:
                        continue
                    bucket_l1_sum[b] += share * w * l1_probs

        # Normalise weighted sums (per-class averages, not a partition of unity).
        for b in range(N_BUCKETS):
            if bucket_weight[b] > 0:
                bucket_l0_sum[b] /= bucket_weight[b]
                bucket_l1_sum[b] /= bucket_weight[b]
            else:
                bucket_l0_sum[b, N_SPECIAL:] = 0.5  # neutral potential when cold

        # ── Format response ────────────────────────────────────────────────────
        # L0 vocab layout: [PAD(0), MASK(1), SOD(2), EOD(3), class_0..class_7]
        l0_classes = L0_CLASSES  # 8 behavioral class names

        raw_potentials = np.zeros((N_BUCKETS, len(l0_classes)), dtype=np.float64)
        for b in range(N_BUCKETS):
            raw_potentials[b] = np.clip(bucket_l0_sum[b, N_SPECIAL:], 0.0, 1.0)

        smoothed_potentials = self._smooth_l0_potentials_across_day(raw_potentials)

        results: list[dict] = []
        for b in range(N_BUCKETS):
            start_time = horizon_start + datetime.timedelta(minutes=BUCKET_MINUTES * b)
            l0_probs = {
                cls: float(smoothed_potentials[b, i])
                for i, cls in enumerate(l0_classes)
            }
            occupant_l0 = l0_classes[int(np.argmax(smoothed_potentials[b]))]

            l0_predictability = {
                cls: float(_quantiles(bucket_class_samples[b][i])[1])
                if bucket_class_samples[b][i]
                else 0.0
                for i, cls in enumerate(l0_classes)
            }
            q10, q50, q90 = (
                _quantiles(bucket_max_potential_samples[b])
                if bucket_max_potential_samples[b]
                else (0.0, 0.0, 0.0)
            )
            # Top-10 L1 clusters by probability (keyed by human-readable label)
            l1_arr = bucket_l1_sum[b]
            top_l1_idx = np.argsort(l1_arr)[::-1][:10]
            l1_probs: dict[str, float] = {}
            for idx in top_l1_idx:
                if l1_arr[idx] > 1e-6:
                    uuid = self._l1_vocab.decode(int(idx))
                    name = self._l1_display_names.get(uuid, uuid[:8])
                    l1_probs[name] = float(l1_arr[idx])

            results.append(
                {
                    "bucket_index": b,
                    "start_time": start_time.isoformat() + "Z",
                    "l0_probs": l0_probs,
                    "occupant_l0": occupant_l0,
                    "l0_predictability": l0_predictability,
                    "l1_probs": l1_probs,
                    "l2_probs": {},  # L2 deferred — no ci.content data
                    "q10": q10,
                    "q50": q50,
                    "q90": q90,
                }
            )

        return results

    def _smooth_l0_potentials_across_day(
        self, raw_potentials: np.ndarray
    ) -> np.ndarray:
        """
        Smooth independent per-class potentials across the day.

        Each L0 class is smoothed along time without renormalizing rows, so
        potentials remain independent energy estimates. Occupant selection
        (argmax) happens after this step.
        """
        try:
            from ci.hbpe.pipeline.l0_temporal_smooth import smooth_l0_potentials

            return smooth_l0_potentials(raw_potentials)
        except Exception:
            log.exception("L0 potential smooth failed — using raw potentials")
            return raw_potentials

    def _smooth_l0_across_day(self, raw_l0: np.ndarray) -> np.ndarray:
        """
        HMM forward–backward over the day's bucket chain.

        Raw per-bucket softmax outputs are independent; this enforces plausible
        contiguous activity blocks (e.g. suppresses TRANSIT→WORK→TRANSIT flicker).
        """
        try:
            from ci.hbpe.pipeline.l0_temporal_smooth import (
                build_l0_transition,
                forward_backward_smooth,
            )

            if self._l0_transition is None:
                self._l0_transition = build_l0_transition(self.user_id)
            return forward_backward_smooth(raw_l0, self._l0_transition)
        except Exception:
            log.exception("L0 temporal smooth failed — using raw histogram")
            return raw_l0

    def invalidate(self, date: datetime.date) -> None:
        """Evict one day from the output cache (call on new event arrival)."""
        self._output_cache.pop(date, None)
        log.debug("Cache invalidated for %s", date)

    def invalidate_all(self) -> None:
        """Clear the entire cache (call after LoRA adapter update)."""
        self._output_cache.clear()
        self._l0_transition = None
        log.info("Inference cache cleared (full invalidation)")


# ── Helpers ────────────────────────────────────────────────────────────────────


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max())
    return e / e.sum()


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _logits_to_potentials(
    logits: np.ndarray, temperature: float, vocab_size: int
) -> np.ndarray:
    """
    Map raw L0 logits to independent 0–1 energy potentials (one per vocab slot).

    Behavioral classes use sigmoid(logit / T) so each is an independent
    "if you'd done nothing else" strength, not a share of a 100% partition.
    """
    arr = np.asarray(logits, dtype=np.float64)
    if arr.shape[0] < vocab_size:
        padded = np.zeros(vocab_size, dtype=np.float64)
        padded[: arr.shape[0]] = arr
        arr = padded
    scaled = arr[:vocab_size] / max(temperature, 1e-6)
    out = np.zeros(vocab_size, dtype=np.float64)
    out[N_SPECIAL:] = _sigmoid(scaled[N_SPECIAL:])
    return out


def _quantiles(values: list[float]) -> tuple[float, float, float]:
    a = np.array(values)
    return (
        float(np.percentile(a, 10)),
        float(np.percentile(a, 50)),
        float(np.percentile(a, 90)),
    )
