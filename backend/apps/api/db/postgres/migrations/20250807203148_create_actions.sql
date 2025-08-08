-- migrate:up
CREATE TABLE actions (
    id UUID PRIMARY KEY,

    title TEXT,
    text TEXT,

    user_id UUID REFERENCES users (id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE action_tag (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    action_id UUID REFERENCES actions(id) NOT NULL,
    tag_id UUID REFERENCES tags(id) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down
DROP TABLE action_tag;
DROP TABLE actions;
