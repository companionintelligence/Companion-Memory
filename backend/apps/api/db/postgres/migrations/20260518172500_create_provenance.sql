-- migrate:up

-- Plan 08: every entity, relationship, and fact gets a structured provenance
-- row recording where it came from and with what confidence. ingest_runs tracks
-- ETL runs and supports rollback by setting rollback_at, which retrieval will
-- filter against in a follow-up.

CREATE TABLE ci.ingest_runs (
    id UUID PRIMARY KEY,
    actor_id UUID NOT NULL REFERENCES ci.actors(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('running','ok','error','partial')),
    cursor TEXT,
    entities_written INT NOT NULL DEFAULT 0,
    relationships_written INT NOT NULL DEFAULT 0,
    error TEXT,
    rollback_at TIMESTAMPTZ
);

CREATE INDEX idx_ingest_runs_actor_provider ON ci.ingest_runs(actor_id, provider, started_at DESC);
CREATE INDEX idx_ingest_runs_rollback ON ci.ingest_runs(rollback_at) WHERE rollback_at IS NOT NULL;

-- One row per (graph row, provenance) tuple. The shape is shared across kinds
-- but split into three tables so ON DELETE CASCADE works without polymorphism.

CREATE TABLE ci.entity_provenance (
    entity_id UUID PRIMARY KEY REFERENCES ci.entities(entity_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user','etl','agent','inferred','skill','migration','legacy')),
    source_provider TEXT,
    source_id TEXT,
    source_uri TEXT,
    ingest_run_id UUID REFERENCES ci.ingest_runs(id) ON DELETE SET NULL,
    model TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_confidence REAL,
    raw_excerpt_hash TEXT
);
CREATE INDEX idx_entity_provenance_source ON ci.entity_provenance(source_provider, source_id);
CREATE INDEX idx_entity_provenance_ingest_run ON ci.entity_provenance(ingest_run_id);
CREATE INDEX idx_entity_provenance_kind ON ci.entity_provenance(kind);

CREATE TABLE ci.relationship_provenance (
    relationship_id UUID PRIMARY KEY REFERENCES ci.relationships(relationship_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user','etl','agent','inferred','skill','migration','legacy')),
    source_provider TEXT,
    source_id TEXT,
    source_uri TEXT,
    ingest_run_id UUID REFERENCES ci.ingest_runs(id) ON DELETE SET NULL,
    model TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_confidence REAL,
    raw_excerpt_hash TEXT
);
CREATE INDEX idx_relationship_provenance_source ON ci.relationship_provenance(source_provider, source_id);
CREATE INDEX idx_relationship_provenance_ingest_run ON ci.relationship_provenance(ingest_run_id);

CREATE TABLE ci.fact_provenance (
    fact_id UUID PRIMARY KEY REFERENCES ci.facts(fact_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user','etl','agent','inferred','skill','migration','legacy')),
    source_provider TEXT,
    source_id TEXT,
    source_uri TEXT,
    ingest_run_id UUID REFERENCES ci.ingest_runs(id) ON DELETE SET NULL,
    model TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_confidence REAL,
    raw_excerpt_hash TEXT
);
CREATE INDEX idx_fact_provenance_source ON ci.fact_provenance(source_provider, source_id);
CREATE INDEX idx_fact_provenance_ingest_run ON ci.fact_provenance(ingest_run_id);

-- Best-effort backfill: every existing row gets kind='legacy' so downstream
-- queries that join on provenance never miss historic rows.
INSERT INTO ci.entity_provenance (entity_id, kind, ingested_at)
SELECT entity_id, 'legacy', COALESCE(created_at, NOW()) FROM ci.entities
ON CONFLICT (entity_id) DO NOTHING;

INSERT INTO ci.relationship_provenance (relationship_id, kind, ingested_at)
SELECT relationship_id, 'legacy', COALESCE(created_at, NOW()) FROM ci.relationships
ON CONFLICT (relationship_id) DO NOTHING;

INSERT INTO ci.fact_provenance (fact_id, kind, ingested_at)
SELECT fact_id, 'legacy', COALESCE(learned_at, NOW()) FROM ci.facts
ON CONFLICT (fact_id) DO NOTHING;

-- migrate:down

DROP TABLE IF EXISTS ci.fact_provenance;
DROP TABLE IF EXISTS ci.relationship_provenance;
DROP TABLE IF EXISTS ci.entity_provenance;
DROP TABLE IF EXISTS ci.ingest_runs;
