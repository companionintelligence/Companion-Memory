-- migrate:up
-- Make connection_id columns nullable to allow preserving data when connections are deleted

-- Drop existing foreign key constraints
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_connection_id_fkey;
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_connection_id_fkey;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_connection_id_fkey;
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_connection_id_fkey;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_connection_id_fkey;
ALTER TABLE api_logs DROP CONSTRAINT IF EXISTS api_logs_connection_id_fkey;

-- Make connection_id columns nullable
ALTER TABLE events ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE people ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE contacts ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE places ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE locations ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE api_logs ALTER COLUMN connection_id DROP NOT NULL;

-- Re-add foreign key constraints with ON DELETE SET NULL
ALTER TABLE events ADD CONSTRAINT events_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;
ALTER TABLE people ADD CONSTRAINT people_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD CONSTRAINT contacts_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;
ALTER TABLE places ADD CONSTRAINT places_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;
ALTER TABLE locations ADD CONSTRAINT locations_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;
ALTER TABLE api_logs ADD CONSTRAINT api_logs_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;

-- migrate:down
-- Restore original constraints (this will fail if there are NULL connection_id values)

-- Drop the new constraints
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_connection_id_fkey;
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_connection_id_fkey;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_connection_id_fkey;
ALTER TABLE places DROP CONSTRAINT IF EXISTS places_connection_id_fkey;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_connection_id_fkey;
ALTER TABLE api_logs DROP CONSTRAINT IF EXISTS api_logs_connection_id_fkey;

-- Make connection_id columns NOT NULL again
ALTER TABLE events ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE people ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE contacts ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE places ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE locations ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE api_logs ALTER COLUMN connection_id SET NOT NULL;

-- Re-add original foreign key constraints
ALTER TABLE events ADD CONSTRAINT events_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id);
ALTER TABLE people ADD CONSTRAINT people_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id);
ALTER TABLE contacts ADD CONSTRAINT contacts_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id);
ALTER TABLE places ADD CONSTRAINT places_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id);
ALTER TABLE locations ADD CONSTRAINT locations_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id);
ALTER TABLE api_logs ADD CONSTRAINT api_logs_connection_id_fkey 
    FOREIGN KEY (connection_id) REFERENCES connections(id);
