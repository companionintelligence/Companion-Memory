-- migrate:up
CREATE TABLE thread_file (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    thread_id UUID REFERENCES threads(id) NOT NULL,
    file_id UUID REFERENCES files(id) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- migrate:down
DROP TABLE thread_file;
