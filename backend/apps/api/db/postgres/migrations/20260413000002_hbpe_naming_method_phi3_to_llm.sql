-- migrate:up
--
-- Normalise naming_method values to model-agnostic labels.
--
-- The original schema (20260227000001) used 'phi3' as the LLM identifier.
-- The current labeler writes 'qwen'.  Both are LLMs; collapse them into the
-- generic 'LLM' value and add an explicit CHECK constraint going forward.
--
-- Valid naming_method values after this migration:
--   'LLM'    — label assigned by any instruct LLM (Qwen, Phi-3, etc.)
--   'ctfidf' — label derived from TF-IDF keyword extraction (legacy, unused)
--   'user'   — label set manually by the user

UPDATE hbpe.l1_clusters SET naming_method = 'LLM' WHERE naming_method IN ('phi3', 'qwen');
UPDATE hbpe.l2_clusters SET naming_method = 'LLM' WHERE naming_method IN ('phi3', 'qwen');

ALTER TABLE hbpe.l1_clusters
    ADD CONSTRAINT l1_clusters_naming_method_check
    CHECK (naming_method IN ('LLM', 'ctfidf', 'user'));

ALTER TABLE hbpe.l2_clusters
    ADD CONSTRAINT l2_clusters_naming_method_check
    CHECK (naming_method IN ('LLM', 'ctfidf', 'user'));

-- migrate:down

ALTER TABLE hbpe.l1_clusters DROP CONSTRAINT IF EXISTS l1_clusters_naming_method_check;
ALTER TABLE hbpe.l2_clusters DROP CONSTRAINT IF EXISTS l2_clusters_naming_method_check;

UPDATE hbpe.l1_clusters SET naming_method = 'phi3' WHERE naming_method = 'LLM';
UPDATE hbpe.l2_clusters SET naming_method = 'phi3' WHERE naming_method = 'LLM';
