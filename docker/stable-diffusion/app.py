import asyncio
import base64
import io
import os
from typing import Optional

import torch
from diffusers import StableDiffusionPipeline
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel


class TextToImageRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    width: int = 1024
    height: int = 1024
    steps: int = 20
    cfg_scale: float = 7.0
    sampler_name: Optional[str] = "DPM++ 2M Karras"
    seed: int = -1
    restore_faces: bool = True
    tiling: bool = False
    do_not_save_samples: bool = True
    do_not_save_grid: bool = True


class TextToImageResponse(BaseModel):
    images: list[str]  # base64 encoded images
    parameters: dict
    info: str


app = FastAPI(title="Stable Diffusion API", version="1.0.0")

# Global pipeline variable
pipeline = None


async def load_pipeline():
    """Load the Stable Diffusion pipeline"""
    global pipeline
    if pipeline is None:
        print("Loading Stable Diffusion pipeline...")
        
        # Use CPU for compatibility, can be changed to CUDA if available
        device = "cuda" if torch.cuda.is_available() else "cpu"
        torch_dtype = torch.float16 if device == "cuda" else torch.float32
        
        try:
            # Try to load a smaller, faster model first
            model_id = "runwayml/stable-diffusion-v1-5"
            pipeline = StableDiffusionPipeline.from_pretrained(
                model_id,
                torch_dtype=torch_dtype,
                use_safetensors=True,
                variant="fp16" if device == "cuda" else None
            )
            pipeline = pipeline.to(device)
            
            # Enable memory efficient attention if available
            if hasattr(pipeline, 'enable_attention_slicing'):
                pipeline.enable_attention_slicing()
            if hasattr(pipeline, 'enable_model_cpu_offload'):
                pipeline.enable_model_cpu_offload()
                
            print(f"Pipeline loaded successfully on {device}")
        except Exception as e:
            print(f"Error loading pipeline: {e}")
            raise


@app.on_event("startup")
async def startup_event():
    """Load the model on startup"""
    await load_pipeline()


@app.get("/internal/ping")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "message": "Stable Diffusion API is running"}


@app.post("/sdapi/v1/txt2img", response_model=TextToImageResponse)
async def text_to_image(request: TextToImageRequest):
    """Generate image from text prompt"""
    global pipeline
    
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    try:
        # Set random seed if not specified
        if request.seed == -1:
            import random
            request.seed = random.randint(0, 2**32 - 1)
        
        # Generate the image
        print(f"Generating image with prompt: {request.prompt[:50]}...")
        
        # Create generator for reproducible results
        generator = torch.Generator(device=pipeline.device).manual_seed(request.seed)
        
        # Generate image
        result = pipeline(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            width=request.width,
            height=request.height,
            num_inference_steps=request.steps,
            guidance_scale=request.cfg_scale,
            generator=generator,
            num_images_per_prompt=1,
        )
        
        # Convert to base64
        image = result.images[0]
        buffered = io.BytesIO()
        image.save(buffered, format="PNG")
        img_base64 = base64.b64encode(buffered.getvalue()).decode()
        
        print("Image generated successfully")
        
        return TextToImageResponse(
            images=[img_base64],
            parameters={
                "prompt": request.prompt,
                "negative_prompt": request.negative_prompt,
                "width": request.width,
                "height": request.height,
                "steps": request.steps,
                "cfg_scale": request.cfg_scale,
                "seed": request.seed,
            },
            info=f"Generated image {request.width}x{request.height} with {request.steps} steps"
        )
        
    except Exception as e:
        print(f"Error generating image: {e}")
        raise HTTPException(status_code=500, detail=f"Image generation failed: {str(e)}")


@app.get("/")
async def root():
    """Root endpoint"""
    return {"message": "Stable Diffusion API", "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7860)