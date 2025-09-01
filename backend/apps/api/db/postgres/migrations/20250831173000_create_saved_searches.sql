-- Create saved_searches table
CREATE TABLE saved_searches (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    description TEXT,
    filters JSON,
    is_smart_search BOOLEAN DEFAULT FALSE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create saved_search_tags junction table
CREATE TABLE saved_search_tags (
    saved_search_id UUID NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (saved_search_id, tag_id)
);

-- Create indexes for better performance
CREATE INDEX idx_saved_searches_user_id ON saved_searches(user_id);
CREATE INDEX idx_saved_searches_created_at ON saved_searches(created_at);
CREATE INDEX idx_saved_searches_is_smart_search ON saved_searches(is_smart_search);
CREATE INDEX idx_saved_search_tags_saved_search_id ON saved_search_tags(saved_search_id);
CREATE INDEX idx_saved_search_tags_tag_id ON saved_search_tags(tag_id);