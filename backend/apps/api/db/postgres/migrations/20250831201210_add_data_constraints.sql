-- migrate:up
-- Optimize data types and add constraints for better data integrity and performance
-- This migration addresses excessive use of TEXT type and missing constraints

-- Add CHECK constraints for enum-like fields
ALTER TABLE events 
    ADD CONSTRAINT chk_events_type_valid CHECK (type IS NULL OR length(type) <= 50),
    ADD CONSTRAINT chk_events_name_not_empty CHECK (name IS NULL OR length(trim(name)) > 0);

ALTER TABLE people
    ADD CONSTRAINT chk_people_type_valid CHECK (type IS NULL OR length(type) <= 50),
    ADD CONSTRAINT chk_people_gender_valid CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to_say')),
    ADD CONSTRAINT chk_people_first_name_not_empty CHECK (first_name IS NULL OR length(trim(first_name)) > 0),
    ADD CONSTRAINT chk_people_last_name_not_empty CHECK (last_name IS NULL OR length(trim(last_name)) > 0);

ALTER TABLE contacts
    ADD CONSTRAINT chk_contacts_type_valid CHECK (type IS NULL OR length(type) <= 50),
    ADD CONSTRAINT chk_contacts_handle_not_empty CHECK (handle IS NULL OR length(trim(handle)) > 0);

ALTER TABLE content
    ADD CONSTRAINT chk_content_type_valid CHECK (type IS NULL OR length(type) <= 100),
    ADD CONSTRAINT chk_content_title_not_empty CHECK (title IS NULL OR length(trim(title)) > 0),
    ADD CONSTRAINT chk_content_mimetype_valid CHECK (mimetype IS NULL OR mimetype ~ '^[a-zA-Z0-9][a-zA-Z0-9!#$&\-\^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-\^_.]*$');

ALTER TABLE things
    ADD CONSTRAINT chk_things_type_valid CHECK (type IS NULL OR length(type) <= 50),
    ADD CONSTRAINT chk_things_name_not_empty CHECK (name IS NULL OR length(trim(name)) > 0);

ALTER TABLE places
    ADD CONSTRAINT chk_places_type_valid CHECK (type IS NULL OR length(type) <= 50),
    ADD CONSTRAINT chk_places_geo_format_valid CHECK (geo_format IS NULL OR geo_format IN ('point', 'polygon', 'multipolygon', 'geojson'));

ALTER TABLE locations
    ADD CONSTRAINT chk_locations_geo_format_valid CHECK (geo_format IS NULL OR geo_format IN ('point', 'polygon', 'multipolygon', 'geojson'));

-- Add constraints for message schema
ALTER TABLE messages
    ADD CONSTRAINT chk_messages_role_valid CHECK (role IS NULL OR role IN ('user', 'assistant', 'system', 'tool')),
    ADD CONSTRAINT chk_messages_mimetype_valid CHECK (mimetype IS NULL OR mimetype ~ '^[a-zA-Z0-9][a-zA-Z0-9!#$&\-\^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-\^_.]*$');

-- Add constraints for thread schema
ALTER TABLE threads
    ADD CONSTRAINT chk_threads_name_not_empty CHECK (name IS NULL OR length(trim(name)) > 0);

-- Improve external_id uniqueness where it makes sense (per user context)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_events_user_external_id_unique 
    ON events(user_id, external_id) WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_people_user_external_id_unique 
    ON people(user_id, external_id) WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_external_id_unique 
    ON contacts(user_id, external_id) WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_content_user_external_id_unique 
    ON content(user_id, external_id) WHERE external_id IS NOT NULL;

-- Add URL validation where URLs are expected
ALTER TABLE events
    ADD CONSTRAINT chk_events_source_url_valid CHECK (source_url IS NULL OR source_url ~ '^https?://');

ALTER TABLE people
    ADD CONSTRAINT chk_people_avatar_url_valid CHECK (avatar_url IS NULL OR avatar_url ~ '^https?://');

ALTER TABLE contacts
    ADD CONSTRAINT chk_contacts_avatar_url_valid CHECK (avatar_url IS NULL OR avatar_url ~ '^https?://');

ALTER TABLE content
    ADD CONSTRAINT chk_content_url_valid CHECK (url IS NULL OR url ~ '^https?://'),
    ADD CONSTRAINT chk_content_source_url_valid CHECK (source_url IS NULL OR source_url ~ '^https?://');

-- Add time constraints for logical consistency
ALTER TABLE events
    ADD CONSTRAINT chk_events_time_order CHECK (start_time IS NULL OR end_time IS NULL OR start_time <= end_time);

-- Add email validation for users (basic regex)
ALTER TABLE users
    ADD CONSTRAINT chk_users_email_format CHECK (email IS NULL OR email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

-- Add constraint for embedding vector dimension consistency (common dimensions: 384, 768, 1536)
ALTER TABLE embeddings
    ADD CONSTRAINT chk_embeddings_vector_dimension CHECK (
        array_length(string_to_array(trim(both '[]' from embedding_vector::text), ','), 1) IN (384, 768, 1024, 1536, 3072)
    );

-- migrate:down
-- Remove constraints and indexes (in reverse order)
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS chk_embeddings_vector_dimension;
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_email_format;
ALTER TABLE events DROP CONSTRAINT IF EXISTS chk_events_time_order;

ALTER TABLE content 
    DROP CONSTRAINT IF EXISTS chk_content_source_url_valid,
    DROP CONSTRAINT IF EXISTS chk_content_url_valid;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS chk_contacts_avatar_url_valid;
ALTER TABLE people DROP CONSTRAINT IF EXISTS chk_people_avatar_url_valid;
ALTER TABLE events DROP CONSTRAINT IF EXISTS chk_events_source_url_valid;

DROP INDEX CONCURRENTLY IF EXISTS idx_content_user_external_id_unique;
DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_user_external_id_unique;
DROP INDEX CONCURRENTLY IF EXISTS idx_people_user_external_id_unique;
DROP INDEX CONCURRENTLY IF EXISTS idx_events_user_external_id_unique;

ALTER TABLE threads DROP CONSTRAINT IF EXISTS chk_threads_name_not_empty;

ALTER TABLE messages 
    DROP CONSTRAINT IF EXISTS chk_messages_mimetype_valid,
    DROP CONSTRAINT IF EXISTS chk_messages_role_valid;

ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_locations_geo_format_valid;

ALTER TABLE places 
    DROP CONSTRAINT IF EXISTS chk_places_geo_format_valid,
    DROP CONSTRAINT IF EXISTS chk_places_type_valid;

ALTER TABLE things 
    DROP CONSTRAINT IF EXISTS chk_things_name_not_empty,
    DROP CONSTRAINT IF EXISTS chk_things_type_valid;

ALTER TABLE content 
    DROP CONSTRAINT IF EXISTS chk_content_mimetype_valid,
    DROP CONSTRAINT IF EXISTS chk_content_title_not_empty,
    DROP CONSTRAINT IF EXISTS chk_content_type_valid;

ALTER TABLE contacts 
    DROP CONSTRAINT IF EXISTS chk_contacts_handle_not_empty,
    DROP CONSTRAINT IF EXISTS chk_contacts_type_valid;

ALTER TABLE people 
    DROP CONSTRAINT IF EXISTS chk_people_last_name_not_empty,
    DROP CONSTRAINT IF EXISTS chk_people_first_name_not_empty,
    DROP CONSTRAINT IF EXISTS chk_people_gender_valid,
    DROP CONSTRAINT IF EXISTS chk_people_type_valid;

ALTER TABLE events 
    DROP CONSTRAINT IF EXISTS chk_events_name_not_empty,
    DROP CONSTRAINT IF EXISTS chk_events_type_valid;