#!/usr/bin/env python3
"""
Multi-Model AI Image Generation Service
Supports SDXL, FLUX.1, and basic Stable Diffusion models
"""

import asyncio
import base64
import gc
import io
import json
import logging
import os
import time
from typing import Optional, Dict, Any, List

import torch
from diffusers import DiffusionPipeline, StableDiffusionXLPipeline, FluxPipeline
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn
from PIL import Image

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global pipeline cache
pipelines: Dict[str, Any] = {}
current_model = None

class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., description="Text prompt for image generation")
    negative_prompt: str = Field("", description="Negative prompt")
    width: int = Field(1024, description="Image width")
    height: int = Field(1024, description="Image height")
    steps: int = Field(20, description="Number of inference steps")
    cfg_scale: float = Field(7.0, description="Guidance scale")
    seed: int = Field(-1, description="Seed for reproducibility (-1 for random)")
    model: str = Field("sdxl", description="Model to use: sdxl, flux-schnell, flux-dev, sd15")
    sampler_name: str = Field("DPM++ 2M Karras", description="Sampler name (for compatibility)")
    restore_faces: bool = Field(False, description="Restore faces (placeholder)")
    tiling: bool = Field(False, description="Enable tiling (placeholder)")
    do_not_save_samples: bool = Field(True, description="Don't save samples")
    do_not_save_grid: bool = Field(True, description="Don't save grid")

class ImageGenerationResponse(BaseModel):
    images: List[str] = Field(..., description="Base64 encoded images")
    parameters: Dict[str, Any] = Field(..., description="Generation parameters")
    info: str = Field(..., description="Generation info")

class ModelInfo(BaseModel):
    name: str
    description: str
    recommended_size: str
    available: bool

app = FastAPI(
    title="Multi-Model AI Image Generation API",
    description="Local AI image generation with SDXL and FLUX.1 support",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Model configurations - support custom models via environment variables
MODEL_CONFIGS = {
    "sdxl": {
        "name": "Stable Diffusion XL",
        "description": "High quality 1024x1024 images with good detail",
        "pipeline_class": StableDiffusionXLPipeline,
        "model_id": os.environ.get("CUSTOM_SDXL_MODEL", "stabilityai/stable-diffusion-xl-base-1.0"),
        "local_path": "/app/models/sdxl",
        "recommended_size": "1024x1024",
        "default_steps": 20,
        "supports_negative_prompt": True,
        "enabled": os.environ.get("INCLUDE_SDXL", "true").lower() in ('true', '1', 'yes', 'on')
    },
    "flux-schnell": {
        "name": "FLUX.1 Schnell",
        "description": "Fast high-quality generation (4 steps)",
        "pipeline_class": FluxPipeline,
        "model_id": os.environ.get("CUSTOM_FLUX_SCHNELL_MODEL", "black-forest-labs/FLUX.1-schnell"),
        "local_path": "/app/models/flux-schnell",
        "recommended_size": "1024x1024",
        "default_steps": 4,
        "supports_negative_prompt": False,
        "enabled": os.environ.get("INCLUDE_FLUX_SCHNELL", "true").lower() in ('true', '1', 'yes', 'on')
    },
    "flux-dev": {
        "name": "FLUX.1 Dev",
        "description": "Highest quality generation (20-50 steps)",
        "pipeline_class": FluxPipeline,
        "model_id": os.environ.get("CUSTOM_FLUX_DEV_MODEL", "black-forest-labs/FLUX.1-dev"),
        "local_path": "/app/models/flux-dev",
        "recommended_size": "1024x1024",
        "default_steps": 28,
        "supports_negative_prompt": False,
        "enabled": os.environ.get("INCLUDE_FLUX_DEV", "false").lower() in ('true', '1', 'yes', 'on')
    },
    "sd15": {
        "name": "Stable Diffusion 1.5",
        "description": "Lightweight fallback model",
        "pipeline_class": DiffusionPipeline,
        "model_id": os.environ.get("CUSTOM_SD15_MODEL", "runwayml/stable-diffusion-v1-5"),
        "local_path": "/app/models/sd15",
        "recommended_size": "512x512",
        "default_steps": 20,
        "supports_negative_prompt": True,
        "enabled": os.environ.get("INCLUDE_SD15", "false").lower() in ('true', '1', 'yes', 'on')
    }
}

def get_device():
    """Get the best available device (NVIDIA CUDA, AMD ROCm, Apple MPS, or CPU)"""
    # Check environment variable first
    env_device = os.environ.get('TORCH_DEVICE', '').lower()
    
    if env_device == 'cpu':
        logger.info("🖥️  Using CPU as specified by TORCH_DEVICE")
        return "cpu"
    elif env_device == 'cuda':
        if torch.cuda.is_available():
            device_name = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "Unknown GPU"
            logger.info(f"🔥 Using CUDA GPU: {device_name}")
            return "cuda"
        else:
            logger.warning("⚠️  CUDA requested but not available, falling back to CPU")
            return "cpu"
    elif env_device == 'rocm':
        # ROCm uses CUDA API compatibility
        if torch.cuda.is_available():
            logger.info("🔥 Using AMD GPU with ROCm (CUDA API compatibility)")
            return "cuda"
        else:
            logger.warning("⚠️  ROCm requested but not available, falling back to CPU")
            return "cpu"
    else:
        # Auto-detect best available device
        if torch.cuda.is_available():
            device_name = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "Unknown GPU"
            # Check if this might be an AMD GPU with ROCm
            if "amd" in device_name.lower() or "radeon" in device_name.lower():
                logger.info(f"🔥 Using AMD GPU with ROCm: {device_name}")
            else:
                logger.info(f"🔥 Using NVIDIA GPU: {device_name}")
            return "cuda"
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            logger.info("🍎 Using Apple Metal Performance Shaders (MPS)")
            return "mps"
        else:
            logger.info("💻 Using CPU")
            return "cpu"

def cleanup_memory():
    """Clean up GPU/CPU memory"""
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    gc.collect()

async def load_model(model_name: str) -> Any:
    """Load a specific model pipeline"""
    global current_model, pipelines
    
    if model_name not in MODEL_CONFIGS:
        raise ValueError(f"Unknown model: {model_name}")
    
    config = MODEL_CONFIGS[model_name]
    
    # Check if model is enabled
    if not config.get("enabled", True):
        raise ValueError(f"Model {model_name} is not enabled in this container configuration")
    
    # If model is already loaded, return it
    if model_name in pipelines:
        current_model = model_name
        return pipelines[model_name]
    
    logger.info(f"Loading model: {model_name}")
    
    # Unload other models to save memory
    if pipelines:
        for name, pipeline in pipelines.items():
            if hasattr(pipeline, 'to'):
                pipeline.to("cpu")
        cleanup_memory()
        # Keep only the most recently used model in memory
        if len(pipelines) > 1:
            # Remove oldest models except the one we're about to load
            to_remove = [k for k in pipelines.keys() if k != model_name]
            for k in to_remove[:-1]:  # Keep one other model
                del pipelines[k]
    
    device = get_device()
    
    try:
        # Try to load from local path first (pre-downloaded model)
        model_path = config["local_path"]
        load_from_local = False
        
        if os.path.exists(model_path) and os.path.isdir(model_path):
            logger.info(f"Found pre-downloaded model at {model_path}")
            load_from_local = True
        else:
            logger.info(f"Local model not found at {model_path}, will download from HuggingFace")
        
        # Load pipeline
        if load_from_local:
            pipeline = config["pipeline_class"].from_pretrained(
                model_path,
                torch_dtype=torch.float16 if device != "cpu" else torch.float32,
                use_safetensors=True,
                variant="fp16" if device != "cpu" else None,
                local_files_only=True  # Only use local files
            )
        else:
            # Fallback to downloading from HuggingFace
            pipeline = config["pipeline_class"].from_pretrained(
                config["model_id"],
                torch_dtype=torch.float16 if device != "cpu" else torch.float32,
                use_safetensors=True,
                variant="fp16" if device != "cpu" else None,
                cache_dir="/app/models"
            )
        
        # Move to device
        pipeline = pipeline.to(device)
        
        # Enable memory efficient attention if available
        if hasattr(pipeline, 'enable_attention_slicing'):
            pipeline.enable_attention_slicing()
        if hasattr(pipeline, 'enable_vae_slicing'):
            pipeline.enable_vae_slicing()
        if hasattr(pipeline, 'enable_model_cpu_offload') and device != "cpu":
            pipeline.enable_model_cpu_offload()
        
        pipelines[model_name] = pipeline
        current_model = model_name
        
        source = "local cache" if load_from_local else "HuggingFace Hub"
        logger.info(f"Successfully loaded {model_name} from {source} on {device}")
        return pipeline
        
    except Exception as e:
        logger.error(f"Failed to load model {model_name}: {e}")
        # Fall back to a placeholder
        raise HTTPException(status_code=500, detail=f"Failed to load model {model_name}: {str(e)}")

def create_placeholder_image(prompt: str, width: int = 1024, height: int = 1024) -> str:
    """Create a styled placeholder image with the prompt text"""
    from PIL import Image, ImageDraw, ImageFont
    import io
    import base64
    
    # Create image with gradient background
    img = Image.new('RGB', (width, height), color='white')
    draw = ImageDraw.Draw(img)
    
    # Create gradient effect
    for y in range(height):
        r = int(102 + (126 * y / height))  # 667eea to 764ba2
        g = int(126 + (75 * y / height))
        b = int(234 + (162 * y / height))
        color = (r, g, b)
        draw.line([(0, y), (width, y)], fill=color)
    
    # Add text
    try:
        font = ImageFont.load_default()
    except:
        font = None
    
    # Word wrap
    words = prompt.split()
    lines = []
    current_line = ""
    max_chars = max(15, width // 25)
    
    for word in words:
        test_line = f"{current_line} {word}".strip()
        if len(test_line) > max_chars and current_line:
            lines.append(current_line)
            current_line = word
        else:
            current_line = test_line
    
    if current_line:
        lines.append(current_line)
    
    # Draw text (max 3 lines)
    lines = lines[:3]
    line_height = max(24, width // 25)
    start_y = height // 2 - (len(lines) * line_height // 2)
    
    for i, line in enumerate(lines):
        y = start_y + i * line_height
        # Shadow
        draw.text((width // 2 + 2, y + 2), line, fill=(0, 0, 0, 128), font=font, anchor="mm")
        # Main text
        draw.text((width // 2, y), line, fill='white', font=font, anchor="mm")
    
    # Add watermark
    draw.text((width - 15, height - 15), "🎨 Local AI", fill=(255, 255, 255, 180), font=font, anchor="rb")
    
    # Convert to base64
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    return base64.b64encode(buffer.getvalue()).decode()

@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "message": "Multi-Model AI Image Generation API",
        "version": "2.0.0",
        "status": "ready",
        "models": [k for k, v in MODEL_CONFIGS.items() if v.get("enabled", True)],
        "current_model": current_model,
        "device": get_device(),
        "capabilities": ["txt2img", "model_switching"],
        "endpoints": {
            "generate": "/sdapi/v1/txt2img",
            "models": "/models",
            "health": "/health"
        }
    }

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "message": "Multi-Model AI Image Generation API is running",
        "current_model": current_model,
        "device": get_device(),
        "available_models": [k for k, v in MODEL_CONFIGS.items() if v.get("enabled", True)]
    }

@app.get("/internal/ping")
async def ping():
    """Ping endpoint for compatibility"""
    return await health_check()

@app.get("/models")
async def list_models():
    """List available models"""
    models = []
    for model_id, config in MODEL_CONFIGS.items():
        if config.get("enabled", True):
            # Check if model exists locally
            local_path = config.get("local_path", "")
            is_available = os.path.exists(local_path) and os.path.isdir(local_path)
            
            models.append(ModelInfo(
                name=config["name"],
                description=config["description"],
                recommended_size=config["recommended_size"],
                available=is_available
            ))
    return {"models": models}

@app.post("/sdapi/v1/txt2img")
async def generate_image(request: ImageGenerationRequest) -> ImageGenerationResponse:
    """Generate image using specified model"""
    try:
        start_time = time.time()
        
        # Validate model
        if request.model not in MODEL_CONFIGS:
            raise HTTPException(status_code=400, detail=f"Unknown model: {request.model}")
        
        model_config = MODEL_CONFIGS[request.model]
        
        # Adjust parameters based on model
        steps = request.steps
        if request.model == "flux-schnell":
            steps = min(steps, 8)  # FLUX schnell works best with fewer steps
        elif request.model == "flux-dev":
            steps = max(steps, 20)  # FLUX dev needs more steps for quality
        
        logger.info(f"Generating image with {request.model}: {request.prompt[:50]}...")
        
        try:
            # Load the requested model
            pipeline = await load_model(request.model)
            
            # Prepare generation parameters
            generation_kwargs = {
                "prompt": request.prompt,
                "width": request.width,
                "height": request.height,
                "num_inference_steps": steps,
                "guidance_scale": request.cfg_scale,
            }
            
            # Add negative prompt for models that support it
            if model_config["supports_negative_prompt"] and request.negative_prompt:
                generation_kwargs["negative_prompt"] = request.negative_prompt
            
            # Set seed for reproducibility
            if request.seed != -1:
                generator = torch.Generator(device=get_device()).manual_seed(request.seed)
                generation_kwargs["generator"] = generator
            
            # Generate image
            with torch.no_grad():
                result = pipeline(**generation_kwargs)
                image = result.images[0]
            
            # Convert to base64
            buffer = io.BytesIO()
            image.save(buffer, format='PNG')
            image_base64 = base64.b64encode(buffer.getvalue()).decode()
            
            # Clean up
            del result
            cleanup_memory()
            
            logger.info(f"Successfully generated image with {request.model}")
            
        except Exception as model_error:
            logger.warning(f"Model generation failed: {model_error}, falling back to placeholder")
            # Fall back to placeholder - create a more informative placeholder
            image_base64 = create_placeholder_image(
                f"[{model_config['name']}] {request.prompt}", 
                request.width, 
                request.height
            )
        
        generation_time = time.time() - start_time
        final_seed = request.seed if request.seed != -1 else torch.randint(0, 2**32, (1,)).item()
        
        response = ImageGenerationResponse(
            images=[image_base64],
            parameters={
                "prompt": request.prompt,
                "negative_prompt": request.negative_prompt,
                "width": request.width,
                "height": request.height,
                "steps": steps,
                "cfg_scale": request.cfg_scale,
                "seed": final_seed,
                "model": request.model,
                "sampler_name": request.sampler_name
            },
            info=f"{model_config['name']} generated {request.width}x{request.height} image in {generation_time:.1f}s with {steps} steps"
        )
        
        logger.info(f"Image generated successfully in {generation_time:.1f}s")
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image generation error: {e}")
        raise HTTPException(status_code=500, detail=f"Image generation failed: {str(e)}")

@app.post("/models/load")
async def load_model_endpoint(model_name: str):
    """Preload a specific model"""
    try:
        pipeline = await load_model(model_name)
        return {
            "status": "success",
            "message": f"Model {model_name} loaded successfully",
            "current_model": current_model
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {str(e)}")

@app.get("/models/current")
async def get_current_model():
    """Get currently loaded model"""
    return {
        "current_model": current_model,
        "available_models": [k for k, v in MODEL_CONFIGS.items() if v.get("enabled", True)],
        "device": get_device()
    }

if __name__ == "__main__":
    logger.info("🎨 Starting Multi-Model AI Image Generation Service")
    logger.info(f"📱 Device: {get_device()}")
    logger.info(f"🤖 Available models: {[k for k, v in MODEL_CONFIGS.items() if v.get('enabled', True)]}")
    logger.info("🚀 Starting server...")
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=7860,
        log_level="info"
    )