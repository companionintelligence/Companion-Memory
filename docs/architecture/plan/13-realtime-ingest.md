# 13 — Realtime Device / IoT Ingest

> **Status:** draft &nbsp;•&nbsp; **Phase:** P6
>
> Build a dedicated, batched, backpressured ingest endpoint for wearables, IoT, AR/XR, and the browser extension. Push, don't pull.

---

## 1. Summary

`measurements`, `position`, `sensors`, and `devices` exist as hypertables. There's no ingest endpoint optimized for high-rate writes, no batching protocol, no MQTT bridge. The wearables in the CI ecosystem (Pebble, Mentra, OMI, Even-Realities, MaixCAM) plus the browser extension and the XR clients generate orders of magnitude more rows than ETL.

## 2. Current state

- Hypertables exist; writes use TypeORM repositories one row at a time.
- No public ingest endpoint optimized for streaming.
- Browser extension polls or pushes via the regular API.

## 3. Target state

### 3.1 Protocols

| Protocol | Use |
|---|---|
| HTTP POST batch | Sync/async clients sending burst data (every 5–60s) |
| WebSocket (binary frames) | Continuous streams (headpose, accelerometer) |
| MQTT bridge | Optional, behind a `mosquitto`-compatible bridge container; for true IoT |

All three converge on the same internal `IngestBatch` shape and writer.

### 3.2 Wire format

```json
{
  "device_id": "uuid",
  "device_token": "...",        // device-actor API key
  "batch_id": "uuid",           // dedup
  "sensors": [
    {
      "name": "heart_rate",
      "measurements": [
        {"t": "2026-05-18T14:00:00Z", "v": 72, "u": "bpm"},
        {"t": "2026-05-18T14:00:01Z", "v": 73}
      ]
    },
    {
      "name": "position",
      "measurements": [
        {"t": "...", "lat": 47.6, "lon": -122.3, "alt": 30, "acc_m": 5}
      ]
    }
  ]
}
```

Schema-on-write: unseen `sensors[].name` auto-creates a sensor descriptor scoped to the device.

### 3.3 Writer

A `BulkInsert` service uses `pg-copy-streams` to COPY into the hypertable. Backpressure via:

- Per-actor write queue with bounded capacity.
- Reject (`429 Retry-After`) when above watermark.
- Dead-letter queue (DLQ) for malformed rows after N retries.

### 3.4 Device authentication

Devices are first-class `device`-kind actors ([10](10-multi-actor.md)) with scoped keys: `devices:ingest:<device_id>`. Tokens are rotatable; key compromise revokes only that device.

### 3.5 Real-time relay

Ingested rows fan out via [05 subscriptions](05-streaming-subscriptions.md) — e.g., the XR client subscribed to `measurement.<user>.<sensor>` sees fresh headpose without polling.

### 3.6 Downsampling

A nightly Temporal job creates `measurements_1m`, `measurements_1h` continuous aggregates (Timescale native), so dashboards and long-range queries stay fast.

## 4. Branch disposition

| Branch | Role |
|---|---|
| `copilot/refactor-connections-etl-system` | The ETL catalog model can subsume the ingest catalog for symmetry. |
| Device repos (Pebble, Mentra, OMI, Even-Realities) | Migrate clients to the new endpoint. |

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | `domains/ingest` module + COPY-stream writer + DLQ |
| 2 | HTTP POST batch endpoint + auth via device-kind actor key |
| 3 | WebSocket binary endpoint |
| 4 | Schema-on-write for unseen sensors |
| 5 | MQTT bridge container (optional) |
| 6 | Continuous aggregates (1m/1h) |
| 7 | Per-device dashboard + last-seen + recent payloads |
| 8 | Subscription wiring |

## 6. Risks

| Risk | Mitigation |
|---|---|
| High-rate writes saturate Postgres | COPY + per-actor queue + watermark; aggregate readers off hypertable. |
| Bad device floods | Throttler by device-actor; auto-disable after error spike. |
| Schema-on-write creates infinite sensors | Cap unique sensor names per device per hour; require explicit registration above the cap. |
| Replay attacks | `batch_id` is unique-per-actor; old `t` rejected past skew tolerance. |

## 7. Eval / acceptance

- Sustained 1k row/s ingest per Hub for one hour without lag in subscriptions.
- A new sensor name auto-creates a descriptor on first batch.
- Disabling a device cuts its writes within one batch.
- The 1m/1h continuous aggregates exist and are used by the SPA dashboard.
