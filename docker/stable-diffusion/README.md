# Local Stable Diffusion Image Generation

This directory contains a containerized Stable Diffusion service that provides local AI image generation capabilities without requiring external API keys.

## Features

- **Local AI**: Runs entirely locally using Stable Diffusion v1.5
- **API Compatible**: Provides a compatible API endpoint for the CI Server
- **CPU/GPU Support**: Automatically detects and uses available hardware
- **Memory Efficient**: Optimized for running on various hardware configurations

## Usage

The service is automatically started as part of the Docker Compose setup:

```bash
# Start all services including Stable Diffusion
docker-compose --profile all up -d

# Or start just the AI services
docker-compose --profile ai up -d
```

## API Endpoints

- **Health Check**: `GET /internal/ping`
- **Text to Image**: `POST /sdapi/v1/txt2img`

## Configuration

The service is configured to:
- Run on port 7860
- Use Stable Diffusion v1.5 model
- Support various image sizes (1024x1024, 1792x1024, 1024x1792)
- Optimize for quality vs speed based on the request

## Hardware Requirements

- **Minimum**: 4GB RAM, CPU-only (slower generation)
- **Recommended**: 8GB+ RAM, NVIDIA GPU with 4GB+ VRAM
- **Generation Time**: 30-60 seconds per image depending on hardware

## Model Downloads

The first startup will download the Stable Diffusion model (~4GB). Subsequent starts will be faster as the model is cached.