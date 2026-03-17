-- migrate:up

-- CI-HBPE-SPEC-001 §3.3 — Prediction logging (hypertable via TimescaleDB)
--
-- Stores every issued forecast bucket for retrospective accuracy measurement
-- (drift detection, LoRA fine-tuning signal).  Actual labels are backfilled
-- nightly by the retrospective actual fill job (T5.1).

CREATE TABLE ci.prediction_log (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    predicted_at    TIMESTAMPTZ NOT NULL,
    horizon_start   TIMESTAMPTZ NOT NULL,
    bucket_index    SMALLINT NOT NULL CHECK (bucket_index BETWEEN 0 AND 47),
    l0_probs        JSONB NOT NULL,          -- {WORK: 0.72, LEISURE: 0.18, ...}
    l1_probs        JSONB NOT NULL,          -- {DEEP_FOCUS: 0.65, MEETING: 0.35}
    l2_probs        JSONB,                   -- null until L2 vocab is established
    actual_l0       TEXT,                    -- filled in retrospectively by T5.1
    actual_l1       TEXT,
    actual_l2       TEXT,
    model_version   TEXT NOT NULL,
    PRIMARY KEY (id, predicted_at)
);

SELECT create_hypertable('ci.prediction_log', 'predicted_at');

CREATE INDEX ON ci.prediction_log (user_id, predicted_at DESC);

-- migrate:down

DROP INDEX IF EXISTS ci.prediction_log_user_id_predicted_at_idx;
DROP TABLE IF EXISTS ci.prediction_log;
