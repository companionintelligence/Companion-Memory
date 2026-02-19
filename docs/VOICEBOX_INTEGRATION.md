# Voicebox Integration Guide

This document describes how to set up and use the voice cloning feature in the CI Server.

## Overview

The voicebox integration allows users to:
- Clone their own voices or other voices they have permission to use
- Create custom voice profiles with multiple audio samples
- Generate speech using cloned voices via the TTS API
- Manage voice profiles through a wizard interface in the settings page

## Architecture

### Components

1. **Voicebox Service** (`backend/apps/voicebox/`)
   - Python FastAPI service running on port 9003
   - Handles voice profile creation, sample storage, and synthesis
   - Stores voice data in `/app/models/voices/`

2. **API Controller** (`backend/apps/api/src/domains/speech/controllers/VoiceboxController.ts`)
   - NestJS controller that proxies requests to the voicebox service
   - Handles authentication and authorization
   - Manages file uploads for voice samples

3. **Database Tables** (`ci.voice_profiles` and `ci.voice_samples`)
   - Stores voice profile metadata and sample references
   - Automatically tracks sample counts and durations
   - Supports multiple voices per user

4. **Frontend Wizard** (`frontend/apps/web/src/components/VoiceCloningWizard/`)
   - Multi-step interface for creating voice profiles
   - Audio recording and file upload capabilities
   - Integrated into the Settings page

## Setup

### 1. Enable Voicebox Service

Add to your `.env` file:
```bash
VOICEBOX_HOST=http://localhost:9003
VOICEBOX_ENABLED=true
```

### 2. Start the Service

Using Docker Compose with the voicebox profile:
```bash
docker-compose --profile local --profile voicebox up
```

Or start individually:
```bash
docker-compose --profile voicebox up voicebox-service
```

### 3. Run Database Migration

The voice cloning tables will be created automatically when migrations run:
```bash
make migrate
```

## Usage

### Creating a Voice Profile

1. Navigate to **Settings** page
2. Scroll to the **Voice Cloning** section
3. Click **Create Profile**
4. Enter:
   - Voice name (required)
   - Description (optional)
   - Language (default: English)
5. Click **Create Profile**

### Adding Voice Samples

1. After creating a profile, you'll be taken to the upload step
2. You can either:
   - **Upload audio files**: Click "Upload Audio Files" and select WAV, MP3, or other audio files
   - **Record audio**: Click "Record Audio" to record directly from your microphone
3. Upload at least 3 samples (5-10 recommended for best quality)
4. Each sample should be 5-30 seconds long
5. Click **Continue** when done

### Using Cloned Voices

Once a voice profile is created, it can be used with the TTS API:

```javascript
// Synthesize speech with a custom voice
const response = await fetch('/api/voicebox/synthesize', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    text: 'Hello, this is my cloned voice!',
    voice_id: 'your-profile-id',
    speed: 1.0,
  }),
  credentials: 'include',
});

const data = await response.json();
// data.audio contains base64-encoded WAV audio
```

## API Endpoints

### Create Voice Profile
```
POST /api/voicebox/profile/create
Content-Type: application/json
Authorization: Required (JWT)

{
  "name": "My Voice",
  "description": "Optional description",
  "language": "en"
}

Response:
{
  "id": "uuid",
  "name": "My Voice",
  "description": "Optional description",
  "language": "en",
  "sample_count": 0,
  "created_at": "2026-02-19T20:00:00Z",
  "updated_at": "2026-02-19T20:00:00Z"
}
```

### Upload Voice Sample
```
POST /api/voicebox/sample/upload
Content-Type: multipart/form-data
Authorization: Required (JWT)

profile_id: uuid
audio_file: File

Response:
{
  "status": "success",
  "sample": {
    "id": "uuid",
    "profile_id": "uuid",
    "filename": "recording-123.webm",
    "duration": 10.5,
    "sample_rate": 22050,
    "uploaded_at": "2026-02-19T20:05:00Z"
  },
  "message": "Sample uploaded successfully"
}
```

### List Voice Profiles
```
GET /api/voicebox/voices
Authorization: Required (JWT)

Response:
{
  "status": "success",
  "voices": [
    {
      "id": "uuid",
      "name": "My Voice",
      "sample_count": 5,
      ...
    }
  ],
  "count": 1
}
```

### Synthesize Speech
```
POST /api/voicebox/synthesize
Content-Type: application/json
Authorization: Required (JWT)

{
  "text": "Text to synthesize",
  "voice_id": "uuid",
  "speed": 1.0
}

Response:
{
  "audio": "base64-encoded-wav-data",
  "sample_rate": 22050,
  "duration": 3.5
}
```

### Delete Voice Profile
```
DELETE /api/voicebox/profile/{profile_id}
Authorization: Required (JWT)

Response:
{
  "status": "success",
  "message": "Profile {profile_id} deleted successfully"
}
```

## Best Practices

### Voice Sample Quality

For best cloning results:

1. **Recording Environment**
   - Record in a quiet room
   - Minimize background noise
   - Use a good quality microphone

2. **Sample Content**
   - Include varied speech patterns
   - Speak naturally and clearly
   - Vary sentence lengths and intonation
   - Read different types of content (statements, questions, emotions)

3. **Sample Quantity**
   - Minimum: 3 samples
   - Recommended: 5-10 samples
   - Each sample: 5-30 seconds

4. **Audio Format**
   - WAV or MP3 preferred
   - Sample rate: 22050 Hz or higher
   - Mono or stereo (mono preferred)

### Security Considerations

1. **User Authentication**
   - All API endpoints require JWT authentication
   - Users can only access their own voice profiles
   - File uploads are validated and sanitized

2. **Data Privacy**
   - Voice samples stored in user-specific directories
   - Database records link samples to user accounts
   - Supports deletion of profiles and samples

3. **Resource Management**
   - Consider setting limits on:
     - Number of profiles per user
     - Number of samples per profile
     - Maximum file size for samples
     - Storage quotas

## Troubleshooting

### Service Not Available

If you see "Voicebox service is not enabled":
1. Check that `VOICEBOX_ENABLED=true` in your environment
2. Verify the voicebox-service is running
3. Check the service is accessible at `VOICEBOX_HOST`

### Audio Recording Issues

If microphone recording doesn't work:
1. Ensure browser has microphone permissions
2. Use HTTPS (required for getUserMedia API)
3. Check browser console for errors

### Upload Failures

If sample uploads fail:
1. Check file format is supported (WAV, MP3, WebM, etc.)
2. Verify file size is reasonable (< 50MB recommended)
3. Check voicebox-service logs for errors

### Poor Voice Quality

If cloned voice quality is poor:
1. Add more voice samples (5-10 recommended)
2. Improve sample quality (reduce background noise)
3. Ensure samples have varied speech patterns
4. Check audio format and sample rate

## Limitations

### Current Implementation

The current implementation is a **placeholder** that demonstrates the API structure and workflow. It generates simple audio tones instead of actual voice cloning.

### Production Deployment

For production use, you would need to integrate:

1. **Voice Cloning Models**
   - Coqui TTS (XTTS)
   - Microsoft SpeechT5
   - OpenVoice
   - Or similar voice cloning systems

2. **Speaker Embeddings**
   - Extract speaker embeddings from samples
   - Store embeddings for voice synthesis
   - Use embeddings for voice similarity

3. **Training Pipeline**
   - Voice adaptation/fine-tuning
   - Model training on voice samples
   - Quality validation

4. **GPU Acceleration**
   - Add CUDA support for faster synthesis
   - Configure GPU resources in Docker
   - Optimize model inference

## Future Enhancements

- [ ] Integrate real voice cloning models (Coqui TTS, XTTS)
- [ ] Add voice training/fine-tuning capabilities
- [ ] Support for multiple languages
- [ ] Voice quality analysis and feedback
- [ ] Batch synthesis for long-form content
- [ ] Voice mixing and audio effects
- [ ] Export/import voice profiles
- [ ] GPU acceleration for faster synthesis
- [ ] Voice similarity search
- [ ] Multi-speaker synthesis
- [ ] Emotion and prosody control

## Related Documentation

- [Voicebox Service README](../../backend/apps/voicebox/README.md)
- [TTS Service Documentation](../../backend/apps/tts/)
- [Speech API Documentation](../../backend/apps/api/src/domains/speech/)

## Support

For issues or questions about voice cloning:
1. Check the troubleshooting section above
2. Review service logs: `docker-compose logs voicebox-service`
3. Check the database for profile/sample records
4. Verify API endpoints are accessible

## Contributing

To contribute to the voicebox integration:
1. Follow the existing patterns in the codebase
2. Add tests for new features
3. Update documentation
4. Submit pull requests with clear descriptions
