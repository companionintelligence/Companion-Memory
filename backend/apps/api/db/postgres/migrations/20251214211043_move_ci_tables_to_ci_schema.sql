-- migrate:up
CREATE SCHEMA IF NOT EXISTS ci;

ALTER TABLE ci_core.connections SET SCHEMA ci;
ALTER TABLE ci_core.providers SET SCHEMA ci;
ALTER TABLE ci_core.sessions SET SCHEMA ci;
ALTER TABLE ci_core.signup_code SET SCHEMA ci;
ALTER TABLE ci_core.users SET SCHEMA ci;

ALTER TABLE public.action_tag SET SCHEMA ci;
ALTER TABLE public.actions SET SCHEMA ci;
ALTER TABLE public.activities SET SCHEMA ci;
ALTER TABLE public.agent_messages SET SCHEMA ci;
ALTER TABLE public.agents SET SCHEMA ci;
ALTER TABLE public.answers SET SCHEMA ci;
ALTER TABLE public.api_logs SET SCHEMA ci;
ALTER TABLE public.browser_activity SET SCHEMA ci;
ALTER TABLE public.communications SET SCHEMA ci;
ALTER TABLE public.content SET SCHEMA ci;
ALTER TABLE public.content_tag SET SCHEMA ci;
ALTER TABLE public.devices SET SCHEMA ci;
ALTER TABLE public.document_chunks SET SCHEMA ci;
ALTER TABLE public.documents SET SCHEMA ci;
ALTER TABLE public.entities SET SCHEMA ci;
ALTER TABLE public.events SET SCHEMA ci;
ALTER TABLE public.facts SET SCHEMA ci;
ALTER TABLE public.files SET SCHEMA ci;
ALTER TABLE public.goals SET SCHEMA ci;
ALTER TABLE public.habit_completions SET SCHEMA ci;
ALTER TABLE public.habits SET SCHEMA ci;
ALTER TABLE public.inventory SET SCHEMA ci;
ALTER TABLE public.measurements SET SCHEMA ci;
ALTER TABLE public.message_files SET SCHEMA ci;
ALTER TABLE public.messages SET SCHEMA ci;
ALTER TABLE public.position SET SCHEMA ci;
ALTER TABLE public.questions SET SCHEMA ci;
ALTER TABLE public.relationships SET SCHEMA ci;
ALTER TABLE public.screen_captures SET SCHEMA ci;
ALTER TABLE public.sensors SET SCHEMA ci;
ALTER TABLE public.tags SET SCHEMA ci;
ALTER TABLE public.threads SET SCHEMA ci;
ALTER TABLE public.voice_recordings SET SCHEMA ci;

ALTER FUNCTION public.document_chunks_search_vector_update SET SCHEMA ci;
ALTER FUNCTION public.entities_search_vector_update SET SCHEMA ci;
ALTER FUNCTION public.facts_search_vector_update SET SCHEMA ci;
ALTER FUNCTION public.gen_uuid_v7 SET SCHEMA ci;
ALTER FUNCTION public.immutable_array_to_string SET SCHEMA ci;
ALTER FUNCTION public.update_entity_outgoing_relationships SET SCHEMA ci;

ALTER TYPE public.access_level SET SCHEMA ci;
ALTER TYPE public.agent_status SET SCHEMA ci;
ALTER TYPE public.agent_type SET SCHEMA ci;
ALTER TYPE public.communication_direction SET SCHEMA ci;
ALTER TYPE public.communication_type SET SCHEMA ci;
ALTER TYPE public.document_content_type SET SCHEMA ci;
ALTER TYPE public.location_source SET SCHEMA ci;
ALTER TYPE public.log_level SET SCHEMA ci;
ALTER TYPE public.message_role SET SCHEMA ci;
ALTER TYPE public.thread_status SET SCHEMA ci;

DROP SCHEMA IF EXISTS ci_core CASCADE;

-- migrate:down
CREATE SCHEMA IF NOT EXISTS ci;

ALTER TABLE ci.users SET SCHEMA ci_core;
ALTER TABLE ci.signup_code SET SCHEMA ci_core;
ALTER TABLE ci.sessions SET SCHEMA ci_core;
ALTER TABLE ci.providers SET SCHEMA ci_core;
ALTER TABLE ci.connections SET SCHEMA ci_core;

ALTER TABLE ci.voice_recordings SET SCHEMA public;
ALTER TABLE ci.threads SET SCHEMA public;
ALTER TABLE ci.tags SET SCHEMA public;
ALTER TABLE ci.sensors SET SCHEMA public;
ALTER TABLE ci.screen_captures SET SCHEMA public;
ALTER TABLE ci.relationships SET SCHEMA public;
ALTER TABLE ci.questions SET SCHEMA public;
ALTER TABLE ci.position SET SCHEMA public;
ALTER TABLE ci.messages SET SCHEMA public;
ALTER TABLE ci.message_files SET SCHEMA public;
ALTER TABLE ci.measurements SET SCHEMA public;
ALTER TABLE ci.inventory SET SCHEMA public;
ALTER TABLE ci.habits SET SCHEMA public;
ALTER TABLE ci.habit_completions SET SCHEMA public;
ALTER TABLE ci.goals SET SCHEMA public;
ALTER TABLE ci.files SET SCHEMA public;
ALTER TABLE ci.facts SET SCHEMA public;
ALTER TABLE ci.events SET SCHEMA public;
ALTER TABLE ci.entities SET SCHEMA public;
ALTER TABLE ci.documents SET SCHEMA public;
ALTER TABLE ci.document_chunks SET SCHEMA public;
ALTER TABLE ci.devices SET SCHEMA public;
ALTER TABLE ci.content_tag SET SCHEMA public;
ALTER TABLE ci.content SET SCHEMA public;
ALTER TABLE ci.communications SET SCHEMA public;
ALTER TABLE ci.browser_activity SET SCHEMA public;
ALTER TABLE ci.api_logs SET SCHEMA public;
ALTER TABLE ci.answers SET SCHEMA public;
ALTER TABLE ci.agents SET SCHEMA public;
ALTER TABLE ci.agent_messages SET SCHEMA public;
ALTER TABLE ci.activities SET SCHEMA public;
ALTER TABLE ci.actions SET SCHEMA public;
ALTER TABLE ci.action_tag SET SCHEMA public;

ALTER FUNCTION ci.update_entity_outgoing_relationships SET SCHEMA public;
ALTER FUNCTION ci.immutable_array_to_string SET SCHEMA public;
ALTER FUNCTION ci.gen_uuid_v7 SET SCHEMA public;
ALTER FUNCTION ci.facts_search_vector_update SET SCHEMA public;
ALTER FUNCTION ci.entities_search_vector_update SET SCHEMA public;
ALTER FUNCTION ci.document_chunks_search_vector_update SET SCHEMA public;

ALTER TYPE ci.thread_status SET SCHEMA public;
ALTER TYPE ci.message_role SET SCHEMA public;
ALTER TYPE ci.log_level SET SCHEMA public;
ALTER TYPE ci.location_source SET SCHEMA public;
ALTER TYPE ci.document_content_type SET SCHEMA public;
ALTER TYPE ci.communication_type SET SCHEMA public;
ALTER TYPE ci.communication_direction SET SCHEMA public;
ALTER TYPE ci.agent_type SET SCHEMA public;
ALTER TYPE ci.agent_status SET SCHEMA public;
ALTER TYPE ci.access_level SET SCHEMA public;

DROP SCHEMA IF EXISTS ci CASCADE;
