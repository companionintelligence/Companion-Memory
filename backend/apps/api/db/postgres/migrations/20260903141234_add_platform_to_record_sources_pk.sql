-- migrate:up

-- ci.record_sources.platform (added in 20260902225107) was left out of the
-- conflict/identity key, so two arrivals of the same (source_type,
-- source_system, source_id) that differ only in platform — e.g. a Gmail
-- fetch and a Microsoft-account fetch both landing under the federated
-- `email` source_system — collapsed onto one row: appendRecordSources'
-- `ON CONFLICT DO NOTHING` silently dropped the second platform.
--
-- `platform` is nullable by design (NULL = "producer couldn't say", a
-- generic mbox/eml or .ics import — see 20260902225107), so it cannot join
-- an actual PRIMARY KEY (which forces NOT NULL on every column). Replace the
-- primary key with a NULLS NOT DISTINCT unique index instead, matching the
-- pattern already used for the other nullable-column identity keys in
-- 20260901175654_cross_pipeline_identity.sql — two NULL-platform arrivals of
-- the same record still collapse to one row (unchanged from before), while
-- two distinct explicit platforms no longer do.
ALTER TABLE ci.record_sources DROP CONSTRAINT record_sources_pkey;

CREATE UNIQUE INDEX record_sources_identity_uniq
  ON ci.record_sources (user_id, record_table, source_type, source_system, source_id, platform)
  NULLS NOT DISTINCT;

-- migrate:down

DROP INDEX IF EXISTS ci.record_sources_identity_uniq;

ALTER TABLE ci.record_sources
  ADD CONSTRAINT record_sources_pkey
  PRIMARY KEY (user_id, record_table, source_type, source_system, source_id);

