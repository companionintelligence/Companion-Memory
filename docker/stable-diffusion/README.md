# Local AI Image Generation Service

This directory contains a local AI image generation service that provides image generation capabilities without requiring external API keys.

## Current Implementation

The current implementation is a **placeholder service** that creates styled placeholder images with the user's prompt text. This provides:

- **Immediate functionality**: Works out of the box without large model downloads
- **API compatibility**: Provides the same API interface as production Stable Diffusion
- **Easy upgrading**: Can be replaced with full Stable Diffusion when needed

## Upgrading to Full Stable Diffusion

To upgrade to actual AI image generation, replace the current service with:

1. **AUTOMATIC1111 Stable Diffusion WebUI**
2. **ComfyUI**
3. **Custom Diffusers implementation**

The API interface is already compatible with Stable Diffusion Web UI format.

## Usage

The service is automatically started as part of the Docker Compose setup:

```bash
# Start all services including image generation
docker-compose --profile all up -d

# Or start just the AI services
docker-compose --profile ai up -d
```

## API Endpoints

- **Health Check**: `GET /internal/ping`
- **Text to Image**: `POST /sdapi/v1/txt2img`

## Configuration

The service runs on port 7860 and supports various image sizes:
- 1024x1024 (square)
- 1792x1024 (landscape) 
- 1024x1792 (portrait)

## Benefits of Local AI

- **Privacy**: No data sent to external services
- **Cost**: No API usage fees
- **Control**: Full control over models and generation parameters
- **Offline**: Works without internet connection