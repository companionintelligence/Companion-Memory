-- migrate:up
--
-- Make centroid nullable in l1_clusters and l2_clusters.
--
-- In the Qwen vocabulary-based labeling architecture, clusters are created
-- on first label encounter and their centroids are populated separately
-- (L1: by the feature extractor; L2: by embedding during discovery).
-- Inserting with NULL centroid and filling it in later is the correct sequence.

ALTER TABLE ci.l1_clusters
    ALTER COLUMN centroid DROP NOT NULL;

ALTER TABLE ci.l2_clusters
    ALTER COLUMN centroid DROP NOT NULL;

-- migrate:down
ALTER TABLE ci.l1_clusters
    ALTER COLUMN centroid SET NOT NULL;

ALTER TABLE ci.l2_clusters
    ALTER COLUMN centroid SET NOT NULL;
