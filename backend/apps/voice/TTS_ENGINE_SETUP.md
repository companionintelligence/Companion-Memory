# TTS Engine Configuration

This voice service now supports two text-to-speech (TTS) engines that can be toggled using an environment variable:

## Available TTS Engines

### 1. Higgs Audio (Default)
- **Engine**: Higgs Audio v2
- **Voice**: Belinda (default)
- **Quality**: High-quality neural voice synthesis
- **Speed**: Configurable
- **Requirements**: Requires boson-ai/higgs-audio installation

### 2. Piper TTS
- **Engine**: Piper neural TTS
- **Voice**: Amy (default English voice)
- **Quality**: Fast, local neural voice synthesis
- **Speed**: Configurable
- **Requirements**: Requires piper-tts package

## Configuration

### Environment Variables

Set the `TTS_ENGINE` environment variable to choose which engine to use:

```bash
# Use Higgs Audio (default)
export TTS_ENGINE=higgs

# Use Piper TTS
export TTS_ENGINE=piper
```

### Piper Model Configuration

For Piper TTS, you can configure the model path using environment variables:

```bash
# Default Piper model paths
export PIPER_MODEL_PATH=/app/models/piper/en_US-amy-low.onnx
export PIPER_CONFIG_PATH=/app/models/piper/en_US-amy-low.onnx.json
```

## API Endpoints

### TTS Generation
- **Endpoint**: `POST /tts`
- **Request Body**:
  ```json
  {
    "text": "Text to convert to speech",
    "voice": "voice_name",
    "speed": 1.0
  }
  ```
- **Response**:
  ```json
  {
    "audio_data": "base64_encoded_audio",
    "duration": 2.5,
    "sample_rate": 22050
  }
  ```

### Health Check
- **Endpoint**: `GET /health`
- **Response includes**:
  ```json
  {
    "tts_engine": "piper",
    "piper_available": true,
    "piper_loaded": true,
    "higgs_audio_loaded": false
  }
  ```

### Preload Endpoints
- **Higgs Audio**: `POST /preload-higgs`
- **Piper**: `POST /preload-piper`

## Docker Setup

The Dockerfile automatically:
1. Installs both TTS engines
2. Downloads a default Piper model
3. Sets up the necessary dependencies

### Building with Docker

```bash
# Build the voice service
docker build -f Dockerfile.voice-service -t voice-service .

# Run with Higgs Audio
docker run -p 9000:9000 -e TTS_ENGINE=higgs voice-service

# Run with Piper TTS
docker run -p 9000:9000 -e TTS_ENGINE=piper voice-service
```

## Testing

Use the provided test script to verify both engines:

```bash
# Test both TTS engines
python test_piper_tts.py
```

## Frontend Integration

The frontend automatically uses the configured TTS engine. The TTS button in the chat interface will:

1. Send requests to the voice service
2. Use the currently configured engine
3. Display appropriate error messages if the engine is unavailable

## Troubleshooting

### Higgs Audio Issues
- Ensure boson-ai/higgs-audio is properly installed
- Check that the model paths are correct
- Verify GPU availability if using CUDA

### Piper TTS Issues
- Ensure piper-tts package is installed
- Check that model files exist at the specified paths
- Verify ONNX runtime compatibility

### General Issues
- Check the health endpoint for engine status
- Review logs for detailed error messages
- Ensure proper environment variable configuration

## Performance Considerations

### Higgs Audio
- **Pros**: High-quality voice synthesis, multiple voice options
- **Cons**: Larger model size, slower generation

### Piper TTS
- **Pros**: Fast generation, smaller model size, local processing
- **Cons**: Limited voice options, potentially lower quality

Choose the engine based on your specific requirements for quality vs. speed.
