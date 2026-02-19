-- migrate:up
-- =================================================================
-- VOICE CLONING TABLES
-- =================================================================
-- Tables for managing custom voice profiles and samples for voice cloning

-- Voice profiles table
CREATE TABLE ci.voice_profiles (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Profile metadata
    name TEXT NOT NULL,
    description TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    
    -- Statistics
    sample_count INTEGER DEFAULT 0,
    total_sample_duration DOUBLE PRECISION DEFAULT 0, -- in seconds
    
    -- Quality metrics (future use)
    quality_score DOUBLE PRECISION, -- 0-1, based on sample quality
    is_trained BOOLEAN DEFAULT FALSE, -- whether voice model is trained
    training_status TEXT, -- 'pending', 'in_progress', 'completed', 'failed'
    
    -- Model information (future use)
    model_path TEXT, -- path to trained voice model
    model_version TEXT,
    
    -- Audit fields
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Voice samples table
CREATE TABLE ci.voice_samples (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    profile_id UUID NOT NULL REFERENCES ci.voice_profiles(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- File information
    file_id UUID REFERENCES ci.files(id) ON DELETE SET NULL, -- reference to uploaded file
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL, -- storage path
    file_size BIGINT,
    
    -- Audio metadata
    duration DOUBLE PRECISION, -- in seconds
    sample_rate INTEGER DEFAULT 22050,
    channels INTEGER DEFAULT 1,
    format TEXT, -- 'wav', 'mp3', 'webm', etc.
    
    -- Quality metrics
    audio_quality_score DOUBLE PRECISION, -- 0-1, signal-to-noise ratio, etc.
    has_background_noise BOOLEAN DEFAULT FALSE,
    is_valid BOOLEAN DEFAULT TRUE,
    
    -- Processing status
    is_processed BOOLEAN DEFAULT FALSE,
    processing_error TEXT,
    
    -- Embeddings (for voice similarity)
    voice_embedding vector(768),
    
    -- Audit fields
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for voice profiles
CREATE INDEX voice_profiles_user_id_idx ON ci.voice_profiles(user_id);
CREATE INDEX voice_profiles_created_at_idx ON ci.voice_profiles(created_at DESC);
CREATE INDEX voice_profiles_training_status_idx ON ci.voice_profiles(training_status) 
    WHERE training_status IS NOT NULL;

-- Indexes for voice samples
CREATE INDEX voice_samples_profile_id_idx ON ci.voice_samples(profile_id);
CREATE INDEX voice_samples_user_id_idx ON ci.voice_samples(user_id);
CREATE INDEX voice_samples_file_id_idx ON ci.voice_samples(file_id) 
    WHERE file_id IS NOT NULL;
CREATE INDEX voice_samples_uploaded_at_idx ON ci.voice_samples(uploaded_at DESC);
CREATE INDEX voice_samples_is_valid_idx ON ci.voice_samples(is_valid) 
    WHERE is_valid = TRUE;

-- Function to update voice profile sample count and duration
CREATE OR REPLACE FUNCTION ci.update_voice_profile_stats()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        UPDATE ci.voice_profiles
        SET 
            sample_count = sample_count + 1,
            total_sample_duration = total_sample_duration + COALESCE(NEW.duration, 0),
            updated_at = NOW()
        WHERE id = NEW.profile_id;
        
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE ci.voice_profiles
        SET 
            sample_count = GREATEST(0, sample_count - 1),
            total_sample_duration = GREATEST(0, total_sample_duration - COALESCE(OLD.duration, 0)),
            updated_at = NOW()
        WHERE id = OLD.profile_id;
        
    ELSIF (TG_OP = 'UPDATE' AND NEW.duration != OLD.duration) THEN
        UPDATE ci.voice_profiles
        SET 
            total_sample_duration = total_sample_duration - COALESCE(OLD.duration, 0) + COALESCE(NEW.duration, 0),
            updated_at = NOW()
        WHERE id = NEW.profile_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update voice profile stats
CREATE TRIGGER update_voice_profile_stats_trigger
AFTER INSERT OR UPDATE OR DELETE ON ci.voice_samples
FOR EACH ROW
EXECUTE FUNCTION ci.update_voice_profile_stats();

-- Function to update voice profile updated_at timestamp
CREATE OR REPLACE FUNCTION ci.update_voice_profile_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update voice profile timestamp
CREATE TRIGGER update_voice_profile_timestamp_trigger
BEFORE UPDATE ON ci.voice_profiles
FOR EACH ROW
EXECUTE FUNCTION ci.update_voice_profile_timestamp();

-- migrate:down
-- Drop triggers and functions
DROP TRIGGER IF EXISTS update_voice_profile_timestamp_trigger ON ci.voice_profiles;
DROP TRIGGER IF EXISTS update_voice_profile_stats_trigger ON ci.voice_samples;
DROP FUNCTION IF EXISTS ci.update_voice_profile_timestamp();
DROP FUNCTION IF EXISTS ci.update_voice_profile_stats();

-- Drop indexes
DROP INDEX IF EXISTS ci.voice_samples_is_valid_idx;
DROP INDEX IF EXISTS ci.voice_samples_uploaded_at_idx;
DROP INDEX IF EXISTS ci.voice_samples_file_id_idx;
DROP INDEX IF EXISTS ci.voice_samples_user_id_idx;
DROP INDEX IF EXISTS ci.voice_samples_profile_id_idx;

DROP INDEX IF EXISTS ci.voice_profiles_training_status_idx;
DROP INDEX IF EXISTS ci.voice_profiles_created_at_idx;
DROP INDEX IF EXISTS ci.voice_profiles_user_id_idx;

-- Drop tables
DROP TABLE IF EXISTS ci.voice_samples;
DROP TABLE IF EXISTS ci.voice_profiles;
