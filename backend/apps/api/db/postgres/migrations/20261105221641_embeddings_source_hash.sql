-- migrate:up
-- What each stored vector was made from: sha256 over the canonical embed
-- model name and the search document. The live search-index listeners
-- re-read a row on every `*UpdatedEvent` — which fires on any field change —
-- and re-embedded it even when the text the vector was built from had not
-- changed. With the hash beside the vector, an unchanged document is a lookup,
-- not a model call. NULL for rows written before this column; the first
-- change to such a row embeds once and stamps it.
ALTER TABLE ci_search.embeddings ADD COLUMN source_hash TEXT;

-- migrate:down
ALTER TABLE ci_search.embeddings DROP COLUMN source_hash;
