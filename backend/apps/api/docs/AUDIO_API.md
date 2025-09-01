# Audio Transcription API

This document describes the backend API endpoints for handling audio file uploads and transcription.

## Endpoints

### Speech-to-Text (STT)
**Endpoint:** `POST /stt`  
**Authentication:** JWT Bearer Token required  
**Description:** Accepts audio files and sends them to the transcription service for speech-to-text conversion.

#### Request
- **Method:** POST
- **Content-Type:** `multipart/form-data`
- **Headers:** 
  - `Authorization: Bearer <jwt-token>`
- **Body:** Audio file uploaded as form data with field name `file`

#### Supported Audio Formats
The transcription service supports common audio formats:
- WAV
- MP3
- FLAC  
- M4A
- OGG

#### Example Request (cURL)
```bash
curl -X POST http://localhost:3030/stt \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "file=@path/to/audio.wav"
```

#### Example Request (JavaScript/Fetch)
```javascript
const formData = new FormData();
formData.append('file', audioFile);

const response = await fetch('/stt', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  },
  body: formData
});

const result = await response.json();
console.log('Transcription:', result.text);
```

#### Response
The endpoint forwards the response from the transcription service. Typical response format:
```json
{
  "text": "This is the transcribed text from the audio file",
  "confidence": 0.95,
  "language": "en",
  "duration": 12.34
}
```

### Text-to-Speech (TTS)
**Endpoint:** `POST /tts`  
**Authentication:** JWT Bearer Token required  
**Description:** Converts text to speech audio.

#### Request
- **Method:** POST
- **Content-Type:** `application/json`
- **Headers:**
  - `Authorization: Bearer <jwt-token>`
  - `Content-Type: application/json`
- **Body:** JSON with text to convert

#### Example Request (cURL)
```bash
curl -X POST http://localhost:3030/tts \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this text will be converted to speech"}'
```

#### Example Request (JavaScript/Fetch)
```javascript
const response = await fetch('/tts', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    text: 'Hello, this text will be converted to speech'
  })
});

const audioBlob = await response.blob();
// Use the audio blob to play or save the generated speech
```

## Architecture

The endpoints use a proxy architecture:

1. **Client** → `POST /stt` or `POST /tts`
2. **API Server** → Validates JWT, forwards request
3. **Transcription Service** → Processes audio/text (WhisperX for STT, SesameAI for TTS)
4. **Response** → Forwarded back to client

### Service Configuration

The transcription services are configured via environment/config:
- **STT Service:** `http://localhost:9001/stt`
- **TTS Service:** `http://localhost:9002/tts`

These can be configured in the config files:
```json
{
  "services": {
    "stt": {
      "host": "http://localhost:9001"
    },
    "tts": {
      "host": "http://localhost:9002"
    }
  }
}
```

## Error Responses

### 401 Unauthorized
```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

### 400 Bad Request (STT - No file provided)
```json
{
  "statusCode": 400,
  "message": "Audio file is required"
}
```

### 502 Bad Gateway (Service unavailable)
```json
{
  "statusCode": 502,
  "message": "Bad Gateway"
}
```

### 504 Gateway Timeout (Service timeout)
```json
{
  "statusCode": 504,
  "message": "Gateway Timeout"
}
```

## Testing

Run the test suite:
```bash
cd backend/apps/api
yarn test src/domains/speech/__tests__/
```

## Integration with Frontend

These endpoints are designed to work with the voice features in the chat interface (PR #108). The frontend can:

1. Capture audio from user microphone
2. Send audio to `/stt` endpoint for transcription
3. Display transcribed text in chat
4. Send AI responses to `/tts` endpoint for speech synthesis
5. Play generated audio to user