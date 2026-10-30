-- migrate:up

-- The connection that fetched this run's bytes, when one did (the companion
-- of origin_platform: that names the service, this names the person's
-- connection to it). The push stamps it as connection_id on every record the
-- run produces and on their provenance ledger rows, which is what lets a
-- disconnect take those records with it — unless the ledger shows the same
-- record also arrived some other way, in which case it stays and only the
-- link is cleared (the rule DataDeletionService already applies to records a
-- connection's own sync wrote).
ALTER TABLE ci_import.import_runs ADD COLUMN IF NOT EXISTS origin_connection_id uuid;

-- migrate:down
ALTER TABLE ci_import.import_runs DROP COLUMN IF EXISTS origin_connection_id;
