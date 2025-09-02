# Multi-Model AI Image Generation Service

A containerized AI image generation service supporting FLUX.1, SDXL, and Stable Diffusion models with pre-downloaded model weights and custom model support.

## Features

- **Multiple Model Support**: FLUX.1-schnell, FLUX.1-dev, SDXL, SD 1.5
- **Multi-Platform**: NVIDIA CUDA, AMD ROCm, Apple MPS, CPU fallback
- **Pre-Downloaded Models**: Models are downloaded at build time for faster startup
- **Custom Model Support**: Use your own HuggingFace model IDs
- **Configurable Selection**: Choose which models to include in your build
- **Optimized Performance**: Model-specific parameters and memory management

## Quick Start

### Default Build (FLUX.1-schnell + SDXL)

```bash
docker build -t my-ai-image-gen ./docker/ai-image-generation
```

### Custom Build with All Models

```bash
docker build \
  --build-arg INCLUDE_FLUX_SCHNELL=true \
  --build-arg INCLUDE_FLUX_DEV=true \
  --build-arg INCLUDE_SDXL=true \
  --build-arg INCLUDE_SD15=true \
  -t my-ai-image-gen-full ./docker/ai-image-generation
```

### Custom Models Build

```bash
docker build \
  --build-arg INCLUDE_SDXL=true \
  --build-arg CUSTOM_SDXL_MODEL="your-username/your-custom-sdxl-model" \
  --build-arg INCLUDE_FLUX_SCHNELL=false \
  -t my-custom-ai-image-gen ./docker/ai-image-generation
```

## Configuration

### Build Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `INCLUDE_FLUX_SCHNELL` | `true` | Include FLUX.1-schnell (fast, 4 steps) |
| `INCLUDE_FLUX_DEV` | `false` | Include FLUX.1-dev (high quality, 28 steps) |
| `INCLUDE_SDXL` | `true` | Include Stable Diffusion XL |
| `INCLUDE_SD15` | `false` | Include Stable Diffusion 1.5 |
| `CUSTOM_FLUX_SCHNELL_MODEL` | `""` | Custom FLUX.1-schnell model ID |
| `CUSTOM_FLUX_DEV_MODEL` | `""` | Custom FLUX.1-dev model ID |
| `CUSTOM_SDXL_MODEL` | `""` | Custom SDXL model ID |
| `CUSTOM_SD15_MODEL` | `""` | Custom SD1.5 model ID |

### Runtime Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TORCH_DEVICE` | `auto` | Force device: `auto`, `cuda`, `cpu`, `rocm` |
| `MODEL_CACHE_DIR` | `/app/models` | Directory for model storage |
| `MAX_MODELS_IN_MEMORY` | `2` | Maximum models to keep loaded |

## Model Information

### FLUX.1 Models
- **FLUX.1-schnell**: Fast generation, 4 steps, optimized sizes: 1024x1024, 768x1344, 1344x768
- **FLUX.1-dev**: High quality, 28 steps, requires HuggingFace token for download

### Stable Diffusion Models
- **SDXL**: Balanced quality/speed, 20 steps, optimized sizes: 1024x1024, 768x1344, 1344x768, 1536x640, 640x1536
- **SD 1.5**: Lightweight, 20 steps, optimized sizes: 512x512, 768x512, 512x768, 640x640

## Recommended Builds

### Lightweight (CPU-friendly)
```bash
docker build \
  --build-arg INCLUDE_FLUX_SCHNELL=false \
  --build-arg INCLUDE_FLUX_DEV=false \
  --build-arg INCLUDE_SDXL=true \
  --build-arg INCLUDE_SD15=true \
  -t ai-image-gen-lite ./docker/ai-image-generation
```

### High Quality (GPU recommended)
```bash
docker build \
  --build-arg INCLUDE_FLUX_SCHNELL=true \
  --build-arg INCLUDE_FLUX_DEV=true \
  --build-arg INCLUDE_SDXL=false \
  --build-arg INCLUDE_SD15=false \
  -t ai-image-gen-flux ./docker/ai-image-generation
```

### Balanced
```bash
docker build \
  --build-arg INCLUDE_FLUX_SCHNELL=true \
  --build-arg INCLUDE_SDXL=true \
  -t ai-image-gen-balanced ./docker/ai-image-generation
```

## Build Time Requirements

- **FLUX.1-schnell**: ~12GB download
- **FLUX.1-dev**: ~24GB download (requires HF token)
- **SDXL**: ~7GB download  
- **SD 1.5**: ~4GB download

Plan for adequate disk space and build time (30-60 minutes depending on models selected).

## GPU Support

### NVIDIA GPUs (CUDA)
```bash
# Auto-detection (recommended)
docker compose up ai-image-generation

# Force NVIDIA GPU usage
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up ai-image-generation
```

### AMD GPUs (ROCm)
```bash
# AMD GPU with ROCm support
docker compose -f docker-compose.yml -f docker-compose.amd.yml up ai-image-generation
```

### CPU Fallback
```bash
# CPU-only mode
TORCH_DEVICE=cpu docker compose up ai-image-generation
```

## API Endpoints

- `POST /sdapi/v1/txt2img` - Generate images
- `GET /models` - List available models
- `GET /health` - Health check
- `GET /` - API information

## Usage Example

```bash
curl -X POST "http://localhost:7860/sdapi/v1/txt2img" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A beautiful sunset over mountains",
    "model": "flux-schnell",
    "width": 1024,
    "height": 1024,
    "steps": 4
  }'
```

## Model-Specific Image Sizes

Each model performs best with specific image dimensions:

- **FLUX.1**: 1024x1024, 768x1344, 1344x768
- **SDXL**: 1024x1024, 768x1344, 1344x768, 1536x640, 640x1536
- **SD 1.5**: 512x512, 768x512, 512x768, 640x640

Using non-optimized dimensions will result in degraded quality and performance.