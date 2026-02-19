# Voicebox Service

A voice cloning and custom text-to-speech service for the CI Server.

## Overview

The Voicebox service allows users to:
- Create custom voice profiles
- Upload voice samples for cloning
- Generate speech using cloned voices
- Manage multiple voice profiles

## Running the Service

### With Docker Compose

The voicebox service is optional and runs in a separate Docker profile.

To enable voicebox, set the environment variable:
```bash
VOICEBOX_ENABLED=true
```

Then start the service with the voicebox profile:
```bash
docker-compose --profile voicebox up voicebox-service
```

Or to run all services including voicebox:
```bash
docker-compose --profile local --profile voicebox up
```

### Standalone

```bash
cd backend/apps/voicebox
pip install -r requirements.txt
python voicebox_service.py
```

The service will run on port 9003.

## API Endpoints

### Create Voice Profile
```bash
POST /voicebox/profile/create
Content-Type: application/json

{
  "name": "My Voice",
  "description": "My personal voice clone",
  "language": "en"
}
```

### Upload Voice Sample
```bash
POST /voicebox/sample/upload
Content-Type: multipart/form-data

profile_id: <profile_id>
audio_file: <audio_file>
```

### List Voice Profiles
```bash
GET /voicebox/voices
```

### Synthesize Speech
```bash
POST /voicebox/synthesize
Content-Type: application/json

{
  "text": "Hello, this is my cloned voice!",
  "voice_id": "<profile_id>",
  "speed": 1.0
}
```

### Delete Voice Profile
```bash
DELETE /voicebox/profile/<profile_id>
```

## Voice Sample Guidelines

For best results:
- Upload 3-10 audio samples per voice
- Each sample should be 5-30 seconds long
- Samples should have clear audio quality
- Record in a quiet environment
- Speak naturally and clearly
- Include varied speech patterns

## Architecture

The voicebox service is designed as a microservice that:
- Stores voice profiles and samples in `/app/models/voices/`
- Accepts audio files in various formats (WAV, MP3, WebM, etc.)
- Returns synthesized speech as base64-encoded WAV audio
- Integrates with the main API through the VoiceboxController

## Current Implementation

**Note:** The current implementation is a placeholder that demonstrates the API structure and workflow. It generates simple audio tones instead of actual voice cloning.

For production use, you would integrate:
- Voice cloning models (e.g., Coqui TTS, XTTS, or similar)
- Speaker embedding extraction
- Voice synthesis with custom embeddings
- Training pipelines for voice adaptation

## Integration with CI Server

The voicebox service is integrated into the CI Server through:

1. **Backend API Controller** (`VoiceboxController.ts`):
   - Proxies authenticated requests to the voicebox service
   - Handles file uploads for voice samples
   - Enforces authentication and authorization

2. **Frontend Wizard** (`VoiceCloningWizard.tsx`):
   - Step-by-step interface for creating voice profiles
   - Audio recording and file upload capabilities
   - Progress tracking and feedback

3. **Settings Page Integration**:
   - Voice cloning wizard embedded in settings page
   - Easy access to voice management features

## Environment Variables

- `VOICEBOX_HOST`: URL of the voicebox service (default: `http://localhost:9003`)
- `VOICEBOX_ENABLED`: Enable/disable the voicebox feature (default: `false`)

## Development

To develop the voicebox service:

1. Make changes to `voicebox_service.py`
2. Test locally with `python voicebox_service.py`
3. Rebuild Docker image: `docker-compose build voicebox-service`
4. Test with Docker: `docker-compose --profile voicebox up voicebox-service`

## Future Enhancements

- [ ] Integrate actual voice cloning models (Coqui TTS, XTTS)
- [ ] Add voice training/fine-tuning capabilities
- [ ] Support for multiple languages
- [ ] Voice quality analysis and feedback
- [ ] Batch synthesis for long-form content
- [ ] Voice mixing and effects
- [ ] Export/import voice profiles
- [ ] GPU acceleration for faster synthesis
