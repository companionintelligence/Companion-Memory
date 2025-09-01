# Speech API Implementation Summary

This implementation provides backend API endpoints for audio transcription (Speech-to-Text) and text-to-speech conversion, addressing issue #105.

## What's Implemented

### 🎤 Speech-to-Text Endpoint (`POST /stt`)
- **Authentication**: JWT Bearer token required
- **File Upload**: Supports multipart/form-data with audio files
- **Validation**: 
  - File presence validation
  - Audio format validation (WAV, MP3, FLAC, M4A, AAC, OGG, etc.)
  - File size limit: 50MB
- **Processing**: Proxies requests to WhisperX transcription service at `localhost:9001`

### 🗣️ Text-to-Speech Endpoint (`POST /tts`)
- **Authentication**: JWT Bearer token required
- **Input**: JSON with `text` field
- **Validation**: Text presence and non-empty validation
- **Processing**: Proxies requests to SesameAI TTS service at `localhost:9002`

## Key Features

✅ **Secure**: JWT authentication for all endpoints  
✅ **Validated**: Input validation for audio files and text  
✅ **Scalable**: Proxy architecture supports external microservices  
✅ **Tested**: Comprehensive test suite with 10+ test cases  
✅ **Documented**: Complete API documentation and examples  
✅ **Error Handling**: Proper HTTP status codes and error messages  

## Fixed Issues

- ✅ **Bug Fix**: TTSController was incorrectly using STT service host
- ✅ **File Validation**: Added proper audio file type validation
- ✅ **Size Limits**: Added appropriate file size limits for audio uploads
- ✅ **Error Handling**: Added proper validation and error responses

## Files Modified/Added

### Core Implementation
- `src/domains/speech/controllers/STTController.ts` - Enhanced with validation
- `src/domains/speech/controllers/TTSController.ts` - Fixed service host + validation
- `src/domains/speech/index.ts` - Already existed, no changes needed

### Tests
- `src/domains/speech/__tests__/STTController.test.ts` - New comprehensive tests
- `src/domains/speech/__tests__/TTSController.test.ts` - New comprehensive tests

### Documentation
- `docs/AUDIO_API.md` - Complete API documentation
- `examples/test-audio-api.js` - Demo script and usage examples

## Usage Examples

### cURL Examples
```bash
# Upload audio for transcription
curl -X POST http://localhost:3030/stt \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "file=@audio.wav"

# Convert text to speech
curl -X POST http://localhost:3030/tts \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}'
```

### JavaScript Examples
```javascript
// STT - Speech to Text
const formData = new FormData();
formData.append('file', audioFile);
const response = await fetch('/stt', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData
});
const result = await response.json();

// TTS - Text to Speech
const response = await fetch('/tts', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ text: 'Hello world' })
});
const audioBlob = await response.blob();
```

## Testing

Run the test suite:
```bash
cd backend/apps/api
yarn test src/domains/speech/__tests__/
```

All tests passing: ✅ 10/10 tests

## Integration

These endpoints integrate with:
- **PR #108**: Voice conversation features for the chat interface
- **WhisperX**: External transcription service (port 9001)
- **SesameAI**: External TTS service (port 9002)
- **JWT Auth**: Existing authentication system
- **File Upload**: Existing file handling infrastructure

## Architecture

```
Client → API Server (Auth + Validation) → External Service → Response
         ↓                                 ↑
      JWT Auth                       WhisperX/SesameAI
     File Validation               (localhost:9001/9002)
```

The proxy architecture provides:
- Security through authentication
- Validation at the gateway
- Scalability through microservices
- Efficient streaming for large files