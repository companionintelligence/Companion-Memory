-- migrate:up
-- Add critical performance indexes for foreign key relationships and common query patterns
-- This migration addresses the lack of indexes on foreign key columns which causes performance issues

-- User-related indexes (most common queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_user_id ON threads(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_created_at ON threads(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_user_created ON threads(user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_prompt_message_id ON messages(prompt_message_id);

-- Memory domain indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_connection_id ON events(connection_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_start_time ON events(start_time);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_end_time ON events(end_time);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_people_user_id ON people(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_people_connection_id ON people(connection_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_people_created_at ON people(created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_connection_id ON contacts(connection_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_person_id ON contacts(person_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_user_id ON content(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_event_id ON content(event_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_created_at ON content(created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_things_user_id ON things(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_things_event_id ON things(event_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_places_user_id ON places(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_places_connection_id ON places(connection_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_places_parent_id ON places(parent_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_locations_user_id ON locations(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_locations_connection_id ON locations(connection_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_locations_place_id ON locations(place_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_locations_datetime ON locations(datetime);

-- Intelligence domain indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_user_id ON questions(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_created_at ON questions(created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_answers_user_id ON answers(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_answers_question_id ON answers(question_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_answers_created_at ON answers(created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_actions_user_id ON actions(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_actions_thread_id ON actions(thread_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_actions_created_at ON actions(created_at);

-- Connection and auth indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_user_id ON connections(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_provider_id ON connections(provider_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_providers_user_id ON providers(user_id);

-- File system indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_user_id ON files(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_created_at ON files(created_at);

-- Tag relationship indexes for join tables
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_tag_event_id ON event_tag(event_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_tag_tag_id ON event_tag(tag_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_person_tag_person_id ON person_tag(person_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_person_tag_tag_id ON person_tag(tag_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_tag_contact_id ON contact_tag(contact_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_tag_tag_id ON contact_tag(tag_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_tag_content_id ON content_tag(content_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_tag_tag_id ON content_tag(tag_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_thing_tag_thing_id ON thing_tag(thing_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_thing_tag_tag_id ON thing_tag(tag_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_place_tag_place_id ON place_tag(place_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_place_tag_tag_id ON place_tag(tag_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_location_tag_location_id ON location_tag(location_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_location_tag_tag_id ON location_tag(tag_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_thread_file_thread_id ON thread_file(thread_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_thread_file_file_id ON thread_file(file_id);

-- JSONB indexes for source_data and other JSON fields
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_source_data ON events USING GIN (source_data);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_people_source_data ON people USING GIN (source_data);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_source_data ON contacts USING GIN (source_data);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_source_data ON content USING GIN (source_data);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_things_source_data ON things USING GIN (source_data);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_places_geolocation ON places USING GIN (geolocation);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_places_location_boundary ON places USING GIN (location_boundary);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_locations_geolocation ON locations USING GIN (geolocation);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_tool_calls ON messages USING GIN (tool_calls);

-- External ID indexes for API integration performance
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_external_id ON events(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_people_external_id ON people(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_external_id ON contacts(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_external_id ON content(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_things_external_id ON things(external_id) WHERE external_id IS NOT NULL;

-- migrate:down
-- Drop performance indexes (in reverse order)
DROP INDEX CONCURRENTLY IF EXISTS idx_things_external_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_external_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_external_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_people_external_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_events_external_id;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_tool_calls;
DROP INDEX CONCURRENTLY IF EXISTS idx_locations_geolocation;
DROP INDEX CONCURRENTLY IF EXISTS idx_places_location_boundary;
DROP INDEX CONCURRENTLY IF EXISTS idx_places_geolocation;
DROP INDEX CONCURRENTLY IF EXISTS idx_things_source_data;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_source_data;
DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_source_data;
DROP INDEX CONCURRENTLY IF EXISTS idx_people_source_data;
DROP INDEX CONCURRENTLY IF EXISTS idx_events_source_data;

DROP INDEX CONCURRENTLY IF EXISTS idx_thread_file_file_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_thread_file_thread_id;

DROP INDEX CONCURRENTLY IF EXISTS idx_location_tag_tag_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_location_tag_location_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_place_tag_tag_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_place_tag_place_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_thing_tag_tag_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_thing_tag_thing_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_tag_tag_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_tag_content_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_contact_tag_tag_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_contact_tag_contact_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_person_tag_tag_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_person_tag_person_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_event_tag_tag_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_event_tag_event_id;

DROP INDEX CONCURRENTLY IF EXISTS idx_files_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_files_user_id;

DROP INDEX CONCURRENTLY IF EXISTS idx_providers_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_connections_provider_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_connections_user_id;

DROP INDEX CONCURRENTLY IF EXISTS idx_actions_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_actions_thread_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_actions_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_answers_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_answers_question_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_answers_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_questions_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_questions_user_id;

DROP INDEX CONCURRENTLY IF EXISTS idx_locations_datetime;
DROP INDEX CONCURRENTLY IF EXISTS idx_locations_place_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_locations_connection_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_locations_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_places_parent_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_places_connection_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_places_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_things_event_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_things_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_event_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_person_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_connection_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_people_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_people_connection_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_people_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_events_end_time;
DROP INDEX CONCURRENTLY IF EXISTS idx_events_start_time;
DROP INDEX CONCURRENTLY IF EXISTS idx_events_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_events_connection_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_events_user_id;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_prompt_message_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_thread_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_thread_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_user_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_threads_user_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_threads_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_threads_user_id;