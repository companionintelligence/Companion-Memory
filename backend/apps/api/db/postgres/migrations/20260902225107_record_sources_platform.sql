-- migrate:up

-- The delivering PLATFORM of one ledger arrival (docs/design/cross-pipeline-identity.md §5).
--
-- record_sources.source_system is the identity system, and for a federated
-- kind that is the KIND (`email`, `calendar`, `file`), not where the datum came
-- from — a Gmail fetch, an Outlook fetch and a Thunderbird mbox of a Yahoo
-- mailbox all ledger under `email`. That erased the one fact the convergence
-- metric needs: whether a second producer for the SAME mailbox exists at all.
-- `platform` is the registry-canonical platform name the arrival's producer
-- knew (`gmail`, `outlook_mail`, `google_calendar`, `onedrive`, …), equal to
-- source_system for platform kinds, and NULL when the producer could not say
-- (a generic mbox/eml or .ics import, an external ingest that named none).
-- NULL pairs with nothing: the doctor's overlap check ignores it rather than
-- counting a mailbox no connection covers as unconverged.
ALTER TABLE ci.record_sources ADD COLUMN platform text;

COMMENT ON COLUMN ci.record_sources.platform IS
  'Registry-canonical platform that delivered this arrival (equals source_system for platform kinds; the producer platform for federated kinds; NULL when unknown — pairs with nothing).';

-- migrate:down

ALTER TABLE ci.record_sources DROP COLUMN platform;
