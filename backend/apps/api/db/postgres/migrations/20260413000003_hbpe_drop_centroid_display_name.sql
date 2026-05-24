-- migrate:up
--
-- Drop centroid columns (always NULL, never read — similarity routing was
-- replaced by Qwen direct labeling per ADR-0002/ADR-0004) and display_name
-- columns (always identical to label in the Qwen architecture; inference
-- engine now derives the human-readable form from label at read time).

ALTER TABLE hbpe.l1_clusters DROP COLUMN IF EXISTS centroid;
ALTER TABLE hbpe.l2_clusters DROP COLUMN IF EXISTS centroid;

ALTER TABLE hbpe.l1_clusters DROP COLUMN IF EXISTS display_name;
ALTER TABLE hbpe.l2_clusters DROP COLUMN IF EXISTS display_name;

-- migrate:down

ALTER TABLE hbpe.l1_clusters ADD COLUMN IF NOT EXISTS centroid FLOAT8[];
ALTER TABLE hbpe.l2_clusters ADD COLUMN IF NOT EXISTS centroid vector(768);

ALTER TABLE hbpe.l1_clusters ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE hbpe.l2_clusters ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE hbpe.l1_clusters SET display_name = replace(label, '_', ' ') WHERE display_name IS NULL;
UPDATE hbpe.l2_clusters SET display_name = replace(label, '_', ' ') WHERE display_name IS NULL;
