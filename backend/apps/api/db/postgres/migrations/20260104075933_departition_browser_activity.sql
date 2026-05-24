-- migrate:up

-- 1. Rename the existing partitioned table
ALTER TABLE ci.browser_activity RENAME TO browser_activity_partitioned_backup;

-- 2. FREE UP THE NAMES: Rename the constraints on the backup table.
ALTER TABLE ci.browser_activity_partitioned_backup RENAME CONSTRAINT browser_activity_pkey TO browser_activity_backup_pkey;
ALTER TABLE ci.browser_activity_partitioned_backup RENAME CONSTRAINT browser_activity_duration_seconds_check TO browser_activity_backup_duration_check;
ALTER TABLE ci.browser_activity_partitioned_backup RENAME CONSTRAINT browser_activity_productivity_score_check TO browser_activity_backup_productivity_check;
ALTER TABLE ci.browser_activity_partitioned_backup RENAME CONSTRAINT browser_activity_scroll_depth_percent_check TO browser_activity_backup_scroll_check;

-- 3. Create the new, standard (non-partitioned) table
CREATE TABLE ci.browser_activity (
    id uuid DEFAULT ci.gen_uuid_v7() NOT NULL,

    "time" timestamp with time zone NOT NULL,

    url text NOT NULL,
    domain text GENERATED ALWAYS AS (
        CASE
            WHEN (url ~ '^https?://'::text) THEN split_part(split_part(url, '://'::text, 2), '/'::text, 1)
            ELSE NULL::text
        END) STORED,
    title text,
    action_type text,
    duration_seconds integer,
    scroll_depth_percent double precision,
    page_summary text,
    page_embedding public.vector(768),
    category text,
    productivity_score double precision,
    is_incognito boolean DEFAULT false,
    contains_sensitive boolean DEFAULT false,

    properties jsonb DEFAULT '{}'::jsonb,

    user_id uuid NOT NULL,
    device_id uuid, -- NOT NULL removed

    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),

    -- Constraints
    CONSTRAINT browser_activity_pkey PRIMARY KEY (id),
    CONSTRAINT browser_activity_duration_seconds_check CHECK ((duration_seconds >= 0)),
    CONSTRAINT browser_activity_productivity_score_check CHECK (((productivity_score >= (0)::double precision) AND (productivity_score <= (1)::double precision))),
    CONSTRAINT browser_activity_scroll_depth_percent_check CHECK (((scroll_depth_percent >= (0)::double precision) AND (scroll_depth_percent <= (100)::double precision)))
);

-- 4. Copy data from the old table to the new one
INSERT INTO ci.browser_activity (
    "time", user_id, device_id, url, title, action_type,
    duration_seconds, scroll_depth_percent, page_summary,
    page_embedding, category, productivity_score,
    is_incognito, contains_sensitive, properties, id
)
SELECT
    "time", user_id, device_id, url, title, action_type,
    duration_seconds, scroll_depth_percent, page_summary,
    page_embedding, category, productivity_score,
    is_incognito, contains_sensitive, properties, id
FROM ci.browser_activity_partitioned_backup;

-- 5. Drop the old table
DROP TABLE ci.browser_activity_partitioned_backup;

-- migrate:down
-- This is a one-way migration.
