#!/usr/bin/env python3
"""
Lightweight CPU-compatible AI Image Generation Service
Falls back to placeholder images when models can't be loaded
"""

import asyncio
import base64
import io
import json
import logging
import os
import time
from typing import Optional, Dict, Any, List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn
from PIL import Image, ImageDraw, ImageFont

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., description="Text prompt for image generation")
    negative_prompt: str = Field("", description="Negative prompt")
    width: int = Field(1024, description="Image width")
    height: int = Field(1024, description="Image height")
    steps: int = Field(20, description="Number of inference steps")
    cfg_scale: float = Field(7.0, description="Guidance scale")
    seed: int = Field(-1, description="Seed for reproducibility (-1 for random)")
    model: str = Field("flux-schnell", description="Model to use")
    sampler_name: str = Field("DPM++ 2M Karras", description="Sampler name")
    restore_faces: bool = Field(False, description="Restore faces")
    tiling: bool = Field(False, description="Enable tiling")
    do_not_save_samples: bool = Field(True, description="Don't save samples")
    do_not_save_grid: bool = Field(True, description="Don't save grid")

class ImageGenerationResponse(BaseModel):
    images: List[str] = Field(..., description="Base64 encoded images")
    parameters: Dict[str, Any] = Field(..., description="Generation parameters")
    info: str = Field(..., description="Generation info")

app = FastAPI(
    title="AI Image Generation API (CPU Fallback)",
    description="Local AI image generation service with model-specific placeholders",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Model info for placeholders
MODEL_INFO = {
    "flux-schnell": {
        "name": "FLUX.1 Schnell",
        "color_scheme": [(0, 150, 255), (150, 0, 255)],  # Blue to purple
        "icon": "⚡"
    },
    "flux-dev": {
        "name": "FLUX.1 Dev", 
        "color_scheme": [(255, 100, 0), (255, 200, 0)],  # Orange to yellow
        "icon": "🔥"
    },
    "sdxl": {
        "name": "Stable Diffusion XL",
        "color_scheme": [(0, 200, 100), (100, 255, 150)],  # Green to light green
        "icon": "🎯"
    },
    "sd15": {
        "name": "Stable Diffusion 1.5",
        "color_scheme": [(100, 100, 255), (200, 150, 255)],  # Blue to light purple
        "icon": "🎨"
    }
}

def create_model_placeholder(prompt: str, model: str, width: int = 1024, height: int = 1024) -> str:
    """Create a model-specific styled placeholder image"""
    
    model_info = MODEL_INFO.get(model, MODEL_INFO["flux-schnell"])
    
    # Create image
    img = Image.new('RGB', (width, height), color='white')
    draw = ImageDraw.Draw(img)
    
    # Create gradient background based on model
    color1, color2 = model_info["color_scheme"]
    for y in range(height):
        ratio = y / height
        r = int(color1[0] + (color2[0] - color1[0]) * ratio)
        g = int(color1[1] + (color2[1] - color1[1]) * ratio)
        b = int(color1[2] + (color2[2] - color1[2]) * ratio)
        draw.line([(0, y), (width, y)], fill=(r, g, b))
    
    # Add overlay pattern
    draw.rectangle([0, 0, width, height // 5], fill=(255, 255, 255, 30))
    
    # Add geometric elements
    icon_size = width // 8
    draw.ellipse([
        width // 6 - icon_size//2, height // 4 - icon_size//2,
        width // 6 + icon_size//2, height // 4 + icon_size//2
    ], fill=(255, 255, 255, 80))
    
    draw.ellipse([
        5*width // 6 - icon_size//3, 3*height // 4 - icon_size//3,
        5*width // 6 + icon_size//3, 3*height // 4 + icon_size//3
    ], fill=(255, 255, 255, 60))
    
    # Add text
    try:
        # Try to load a font, fall back to default
        font_size = max(16, width // 35)
        font = ImageFont.load_default()
    except:
        font = None
        font_size = 16
    
    # Model name and icon
    model_text = f"{model_info['icon']} {model_info['name']}"
    model_bbox = draw.textbbox((0, 0), model_text, font=font)
    model_width = model_bbox[2] - model_bbox[0]
    draw.text(
        (width // 2 - model_width // 2, height // 6),
        model_text,
        fill='white',
        font=font
    )
    
    # Word wrap the prompt
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
    
    # Draw prompt text (max 4 lines)
    lines = lines[:4]
    line_height = max(24, width // 30)
    start_y = height // 2 - (len(lines) * line_height // 2)
    
    for i, line in enumerate(lines):
        y = start_y + i * line_height
        # Shadow
        draw.text((width // 2 + 2, y + 2), line, fill=(0, 0, 0, 100), font=font, anchor="mm")
        # Main text
        draw.text((width // 2, y), line, fill='white', font=font, anchor="mm")
    
    # Add technical info
    tech_info = f"Model: {model.upper()} | Resolution: {width}x{height}"
    tech_bbox = draw.textbbox((0, 0), tech_info, font=font)
    tech_width = tech_bbox[2] - tech_bbox[0]
    draw.text(
        (width // 2 - tech_width // 2, 5 * height // 6),
        tech_info,
        fill=(255, 255, 255, 200),
        font=font
    )
    
    # Add watermark
    watermark = "🤖 Local AI Generation"
    draw.text((width - 15, height - 15), watermark, fill=(255, 255, 255, 150), font=font, anchor="rb")
    
    # Convert to base64
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    return base64.b64encode(buffer.getvalue()).decode()

@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "message": "AI Image Generation API (CPU Fallback Mode)",
        "version": "2.0.0",
        "status": "ready",
        "mode": "cpu_fallback",
        "models": list(MODEL_INFO.keys()),
        "capabilities": ["txt2img", "model_aware_placeholders"],
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
        "message": "AI Image Generation API is running in CPU fallback mode",
        "mode": "cpu_fallback",
        "available_models": list(MODEL_INFO.keys())
    }

@app.get("/internal/ping")
async def ping():
    """Ping endpoint for compatibility"""
    return await health_check()

@app.get("/models")
async def list_models():
    """List available models"""
    models = []
    for model_id, info in MODEL_INFO.items():
        models.append({
            "name": info["name"],
            "description": f"Model-aware placeholder generation for {info['name']}",
            "recommended_size": "1024x1024",
            "available": True,
            "mode": "placeholder"
        })
    return {"models": models}

@app.post("/sdapi/v1/txt2img")
async def generate_image(request: ImageGenerationRequest) -> ImageGenerationResponse:
    """Generate model-specific placeholder image"""
    try:
        start_time = time.time()
        
        logger.info(f"Generating placeholder with {request.model}: {request.prompt[:50]}...")
        
        # Create model-specific placeholder
        image_base64 = create_model_placeholder(
            request.prompt,
            request.model,
            request.width,
            request.height
        )
        
        generation_time = time.time() - start_time
        final_seed = request.seed if request.seed != -1 else int(time.time() * 1000) % (2**32)
        
        model_name = MODEL_INFO.get(request.model, MODEL_INFO["flux-schnell"])["name"]
        
        response = ImageGenerationResponse(
            images=[image_base64],
            parameters={
                "prompt": request.prompt,
                "negative_prompt": request.negative_prompt,
                "width": request.width,
                "height": request.height,
                "steps": request.steps,
                "cfg_scale": request.cfg_scale,
                "seed": final_seed,
                "model": request.model,
                "sampler_name": request.sampler_name
            },
            info=f"{model_name} placeholder generated {request.width}x{request.height} image in {generation_time:.1f}s"
        )
        
        logger.info(f"Placeholder generated successfully in {generation_time:.1f}s")
        return response
        
    except Exception as e:
        logger.error(f"Placeholder generation error: {e}")
        raise HTTPException(status_code=500, detail=f"Image generation failed: {str(e)}")

if __name__ == "__main__":
    logger.info("🎨 Starting AI Image Generation Service (CPU Fallback Mode)")
    logger.info(f"🤖 Available model placeholders: {list(MODEL_INFO.keys())}")
    logger.info("🚀 Starting server...")
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=7860,
        log_level="info"
    )