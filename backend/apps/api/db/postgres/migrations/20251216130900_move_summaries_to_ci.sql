-- migrate:up
ALTER TABLE summaries SET SCHEMA ci;
-- migrate:down
ALTER TABLE ci.summaries SET SCHEMA public;