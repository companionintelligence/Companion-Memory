# Multi-Model AI Image Generation Service

A local AI image generation service that supports multiple state-of-the-art models with multi-GPU compatibility.

## Supported Models

### FLUX.1 Models (Recommended)
- **FLUX.1-schnell**: Fast generation (4 steps), excellent quality
- **FLUX.1-dev**: Highest quality (20-50 steps), state-of-the-art results

### Stable Diffusion Models
- **SDXL**: High quality 1024x1024 native resolution
- **SD 1.5**: Lightweight fallback model

## GPU Support

The service supports multiple GPU types and automatically detects available hardware:

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

## Timeout Configuration

The service supports configurable timeouts for different models via backend configuration:

- **flux-schnell**: 2 minutes (fast generation)
- **flux-dev**: 10 minutes (high quality, more steps)
- **sdxl/sd15**: 5 minutes (standard generation)
- **future video**: 30 minutes (reserved for video generation)

## API Endpoints

### Generate Image
```
POST /sdapi/v1/txt2img
```

Request body:
```json
{
  "prompt": "A beautiful sunset over mountains",
  "model": "flux-schnell",
  "width": 1024,
  "height": 1024,
  "steps": 4,
  "cfg_scale": 7.0,
  "seed": -1
}
```

### Available Models
```
GET /models
```

### Health Check
```
GET /health
GET /internal/ping
```

## Model Selection

Choose the right model for your use case:

- **flux-schnell**: Best for fast, high-quality generation (4 steps, 2 min timeout)
- **flux-dev**: Best for highest quality (28 steps, 10 min timeout)
- **sdxl**: Good balance of quality and speed (20 steps, 5 min timeout)
- **sd15**: Lightweight fallback (20 steps, 5 min timeout)

## Model-Specific Prompting

- **FLUX.1 models**: Natural language descriptions (Black Forest Labs style)
- **Stable Diffusion models**: Tag-based prompting with negative prompts

## Memory Management

The service automatically manages model loading and memory usage:
- Models are loaded on-demand
- GPU memory is cleared between model switches
- CPU offloading is used when available
- Memory efficient attention is enabled

## Hardware Requirements

- **Minimum**: 8GB RAM, CPU-only (slow)
- **Recommended**: 12GB VRAM GPU + 16GB RAM
- **Optimal**: 24GB VRAM GPU + 32GB RAM

## Environment Variables

- `TORCH_DEVICE`: Force specific device (auto, cuda, rocm, cpu)
- `ROCM_VISIBLE_DEVICES`: AMD GPU devices for ROCm (all)
- `MODEL_CACHE_DIR`: Directory to cache downloaded models
- `MAX_MODELS_IN_MEMORY`: Maximum models to keep loaded (default: 2)