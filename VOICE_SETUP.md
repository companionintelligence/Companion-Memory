# Voice Features Setup Guide

This guide explains how to set up and use the voice transcription features in the chat application.

## Overview

The voice features include:
- **Real-time speech-to-text transcription** using WhisperX
- **Voice chat integration** in the chat interface

## Prerequisites

1. **Python 3.8+** installed on your system
2. **Docker** (for running WhisperX service)
3. **Microphone access** in your browser

## Setup Instructions

### 1. Start the Voice Service

The Voice Service (powered by WhisperX) runs on port 9002.

#### Option A: Using Docker (Recommended)

```bash
# Start the Voice Service
docker-compose up voice-service

# Or start all services
docker-compose up
```

#### Option B: Local Development

```bash
# Navigate to the backend directory
cd backend

# Create and activate virtual environment
python3 -m venv voice_env
source voice_env/bin/activate  # On Windows: voice_env\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the Voice Service
python voice_service.py
```

### 2. Verify Service Status

Check if the Voice Service is running:

```bash
# Health check endpoint
curl http://localhost:9002/health

# Expected response:
# {"status": "healthy", "device": "cpu", "model_loaded": true}
```

### 3. Test the Voice API

Test the voice transcription API:

```bash
# Test the voice service health
curl https://dev.companionintelligence.com/api/voice/health

# Expected response:
# {"status": "healthy", "whisperx": true, "sesameai": false}
```

## Using Voice Features

### 1. Enable Voice Mode

1. Open the chat page
2. Click the "Voice" button to enter voice mode
3. The button will show "(Offline)" if the Voice Service is not available

### 2. Start Recording

1. In voice mode, click "Start" to begin recording
2. Speak clearly into your microphone
3. You'll see real-time transcription of your speech
4. The audio waveform will show your voice level

### 3. Stop and Send

1. Click "Stop" to end recording
2. The final transcription will be displayed
3. The transcribed text will be sent as a message to the chat
4. You'll receive a response from the assistant

## WhisperX Sensitivity

The WhisperX service has been configured with **10x increased sensitivity** to better capture quiet speech:

- **Audio RMS threshold**: Reduced from 0.001 to 0.0001 (10x more sensitive)
- **Compression ratio threshold**: Reduced from 2.4 to 0.5 (more permissive)
- **Log probability threshold**: Reduced from -1.0 to -3.0 (more permissive)
- **No speech threshold**: Reduced from 0.1 to 0.01 (more permissive)

This means WhisperX will now:
- Detect much quieter speech
- Transcribe speech with lower confidence
- Be less likely to filter out speech as silence
- Work better in quiet environments

## Troubleshooting

### Voice Service Not Starting

1. **Check port conflicts**: Ensure port 9002 is available
2. **Verify Python dependencies**: Make sure all requirements are installed
3. **Check logs**: Look for error messages in the service logs

### No Transcription

1. **Check microphone permissions**: Ensure your browser has microphone access
2. **Verify service status**: Check if the Voice Service is running and accessible
3. **Test with simple audio**: Try speaking clearly and slowly

### Poor Transcription Quality

1. **Use a good microphone**: Better hardware improves accuracy
2. **Speak clearly**: Enunciate words and avoid background noise
3. **Check audio format**: Ensure 16kHz mono audio is being sent

## Configuration

### Environment Variables

- `WHISPERX_API_URL`: Internal URL of the Voice Service (default: `http://voice-service:9000`)

### Service URLs

- **Frontend Voice Client**: `https://dev.companionintelligence.com/api/voice/*`
- **Main API Service**: `http://host.docker.internal:3030` (internal)
- **Voice Service**: `http://voice-service:9000` (internal Docker network)
- **Voice Service External**: `http://localhost:9002` (host port mapping)

### Audio Settings

- **Sample Rate**: 16kHz (required by WhisperX)
- **Channels**: Mono (1 channel)
- **Format**: PCM audio data

## Development Notes

### Real Transcription

The voice features now use real WhisperX transcription:

- All voice input is processed by the live Voice Service (WhisperX)
- High-quality speech-to-text conversion with timestamps
- Support for multiple languages and model sizes
- Real-time transcription during voice recording

### Performance

- **Model Loading**: Voice Service models are loaded on service startup
- **Memory Usage**: Large models require significant RAM
- **GPU Support**: CUDA acceleration is available if configured

## Architecture

The voice features use a clean layered architecture:

```
Frontend (ChatPage) 
    ↓ (HTTPS)
dev.companionintelligence.com/api/voice/*
    ↓ (Nginx reverse proxy)
Main API Service (NestJS on port 3030)
    ↓ (Internal Docker network)
Voice Service (Python on port 9000)
```

This architecture provides:
- **Security**: All requests go through authenticated API endpoints
- **Error Handling**: Centralized error handling and logging
- **Session Management**: Voice sessions managed by the main API
- **Consistency**: All API endpoints follow the same pattern
- **Simplicity**: Single API gateway for all voice operations

## API Endpoints

### Voice API Endpoints

- `POST /api/voice/stream/start` - Start voice session
- `POST /api/voice/stream/audio/:sessionId` - Process audio chunk
- `POST /api/voice/stream/stop/:sessionId` - Stop voice session
- `GET /api/voice/health` - Service health check

### Internal Voice Service Endpoints

- `POST /transcribe` - Transcribe audio (internal only)
- `GET /health` - Service health (internal only)
- `GET /models` - List available models (internal only)

## Future Enhancements

- [ ] Text-to-speech responses using SesameAI/CSM
- [ ] Voice activity detection
- [ ] Multiple language support
- [ ] Custom voice models
- [ ] Real-time streaming responses 