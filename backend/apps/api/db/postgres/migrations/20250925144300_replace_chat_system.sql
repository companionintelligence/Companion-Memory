-- migrate:up
-- =================================================================
-- SAFELY REPLACE CHAT SYSTEM WITH COMPREHENSIVE threadS/MESSAGES
-- =================================================================
-- Handle all dependencies before dropping threads/messages

-- Step 1: Drop thread_file table first (it references both threads and files)
DROP TABLE IF EXISTS thread_file;

-- Step 2: Update actions table to reference threads instead of threads
-- First add the new column

-- Copy any existing thread_id data to thread_id (if needed for data preservation)
-- UPDATE actions SET thread_id = thread_id WHERE thread_id IS NOT NULL;
-- Drop the old thread_id column
ALTER TABLE actions DROP COLUMN IF EXISTS thread_id;

-- Step 3: Now safely drop existing chat tables
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS threads;

-- Step 4: Create comprehensive threads table from CI-Database
CREATE TABLE threads (
    thread_id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- thread metadata
    title TEXT, -- Auto-generated or user-set thread title
    summary TEXT, -- AI-generated summary of thread topics
    
    -- Temporal tracking
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_message_at TIMESTAMPTZ,
    
    -- thread state
    status thread_status DEFAULT 'active',
    is_archived BOOLEAN DEFAULT FALSE,
    
    -- Context and intelligence - this should be all AI generated, provides better history
    main_topics TEXT[], -- Extracted main discussion topics
    mentioned_entities TEXT[], -- People, places, concepts mentioned
    context_embedding vector(768), -- Vector embedding of thread context
    
    -- thread settings
    model_config JSONB DEFAULT '{}', -- Model settings for this thread
    temperature DOUBLE PRECISION,
    max_tokens INTEGER,
    system_prompt TEXT,
    
    -- thread statistics
    message_count INTEGER DEFAULT 0,
    total_tokens_used INTEGER DEFAULT 0,
    avg_response_time_ms INTEGER,
    
    -- Branching and forking
    parent_thread_id UUID REFERENCES threads(thread_id),
    fork_point_message_id UUID, -- Which message this thread forked from
    
    -- Privacy and sharing
    is_private BOOLEAN DEFAULT TRUE,
    sharing_permissions JSONB DEFAULT '{}'
);

-- Step 5: Create comprehensive messages table from CI-Database  
CREATE TABLE messages (
    message_id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Message ordering and hierarchy
    parent_message_id UUID REFERENCES messages(message_id), -- For branching threads
    depth INTEGER DEFAULT 0, -- Depth in thread tree
    sequence_number INTEGER,
    
    -- Message content and type
    role message_role NOT NULL,
    content TEXT,--  NOT NULL,
    content_type TEXT DEFAULT 'text/plain', -- text/plain, text/markdown, application/json, etc.
    
    -- AI model information (for assistant messages)
    model_name TEXT, -- gpt-4, claude-3, etc.
    model_version TEXT,
    temperature DOUBLE PRECISION,
    
    -- Token and cost tracking
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
    estimated_cost DECIMAL(10,6), -- Estimated API cost for this message
    
    -- Processing metadata
    processing_time_ms INTEGER, -- How long the model took to respond
    finish_reason TEXT, -- stop, length, content_filter, etc.
    
    -- Message state
    is_edited BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    edit_history JSONB DEFAULT '[]', -- Previous versions of edited content
    
    -- Tool usage (for assistant messages with function calls)
    tool_calls JSONB DEFAULT '[]', -- Function calls made by the assistant
    tool_call_results JSONB DEFAULT '[]', -- Results from tool calls
    
    -- Semantic analysis
    message_embedding vector(768), -- Vector representation for similarity search
    extracted_entities TEXT[], -- People, places, concepts mentioned
    sentiment_score DOUBLE PRECISION CHECK (sentiment_score >= -1 AND sentiment_score <= 1),
    intent_categories TEXT[], -- Categorized user intents
    
    -- User feedback and ratings
    user_rating INTEGER CHECK (user_rating >= 1 AND user_rating <= 5),
    user_feedback TEXT,
    flagged_for_review BOOLEAN DEFAULT FALSE,
    flag_reason TEXT,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Full-text search vector (generated column)
    search_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('english',
        coalesce(content, '') || ' ' ||
        coalesce(array_to_string(extracted_entities, ' '), '') || ' ' ||
        coalesce(array_to_string(intent_categories, ' '), '')
      )
    ) STORED
    
    -- Constraints
   -- CONSTRAINT valid_sequence_per_thread UNIQUE (thread_id, sequence_number),
   -- CONSTRAINT content_not_empty CHECK (LENGTH(TRIM(content)) > 0)
);

-- Step 6: Create indexes for messages table
CREATE INDEX messages_thread_idx ON messages(thread_id);
CREATE INDEX messages_user_idx ON messages(user_id);
CREATE INDEX messages_role_idx ON messages(role);
CREATE INDEX messages_created_idx ON messages(created_at DESC);
CREATE INDEX messages_fts_idx ON messages USING GIN(search_vector);
CREATE INDEX messages_embedding_idx ON messages USING hnsw (message_embedding vector_cosine_ops)
    WHERE message_embedding IS NOT NULL;

-- Step 7: Add thread_id column back to actions table and create FK constraint
ALTER TABLE actions ADD COLUMN thread_id UUID;
ALTER TABLE actions ADD CONSTRAINT actions_thread_fk 
    FOREIGN KEY (thread_id) REFERENCES threads(thread_id);

-- migrate:down
-- Revert all changes
ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_thread_fk;
ALTER TABLE actions DROP COLUMN IF EXISTS thread_id;

-- Drop indexes first
DROP INDEX IF EXISTS messages_embedding_idx;
DROP INDEX IF EXISTS messages_fts_idx;
DROP INDEX IF EXISTS messages_created_idx;
DROP INDEX IF EXISTS messages_role_idx;
DROP INDEX IF EXISTS messages_user_idx;
DROP INDEX IF EXISTS messages_thread_idx;

DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS threads;
