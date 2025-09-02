#!/usr/bin/env python3
"""
Model downloader for AI image generation container
Downloads selected models at build time to avoid runtime downloads
"""

import os
import sys
from typing import Dict, List

def str_to_bool(value: str) -> bool:
    """Convert string to boolean"""
    return value.lower() in ('true', '1', 'yes', 'on')

def get_model_id(default_model: str, custom_model_env: str) -> str:
    """Get model ID, preferring custom model if set"""
    custom_model = os.environ.get(custom_model_env, '').strip()
    return custom_model if custom_model else default_model

def main():
    """Download models based on environment configuration"""
    print("🤖 Model downloader starting...")
    
    # Check which models to download
    models_to_download: Dict[str, str] = {}
    
    if str_to_bool(os.environ.get('INCLUDE_FLUX_SCHNELL', 'true')):
        model_id = get_model_id('black-forest-labs/FLUX.1-schnell', 'CUSTOM_FLUX_SCHNELL_MODEL')
        models_to_download['flux-schnell'] = model_id
        print(f"✓ FLUX.1-schnell will be downloaded: {model_id}")
    
    if str_to_bool(os.environ.get('INCLUDE_FLUX_DEV', 'false')):
        model_id = get_model_id('black-forest-labs/FLUX.1-dev', 'CUSTOM_FLUX_DEV_MODEL')
        models_to_download['flux-dev'] = model_id
        print(f"✓ FLUX.1-dev will be downloaded: {model_id}")
    
    if str_to_bool(os.environ.get('INCLUDE_SDXL', 'true')):
        model_id = get_model_id('stabilityai/stable-diffusion-xl-base-1.0', 'CUSTOM_SDXL_MODEL')
        models_to_download['sdxl'] = model_id
        print(f"✓ SDXL will be downloaded: {model_id}")
    
    if str_to_bool(os.environ.get('INCLUDE_SD15', 'false')):
        model_id = get_model_id('runwayml/stable-diffusion-v1-5', 'CUSTOM_SD15_MODEL')
        models_to_download['sd15'] = model_id
        print(f"✓ SD1.5 will be downloaded: {model_id}")
    
    if not models_to_download:
        print("⚠️ No models configured for download. At least one model should be enabled.")
        return
    
    print(f"\n📥 Downloading {len(models_to_download)} model(s)...")
    
    # Import after we know we need it
    try:
        from diffusers import DiffusionPipeline, StableDiffusionXLPipeline, FluxPipeline
        import torch
    except ImportError as e:
        print(f"❌ Failed to import required libraries: {e}")
        sys.exit(1)
    
    # Determine device for downloads (CPU is safer for downloads)
    device = "cpu"
    torch_dtype = torch.float32
    
    success_count = 0
    failed_models: List[str] = []
    
    for model_name, model_id in models_to_download.items():
        try:
            print(f"\n📦 Downloading {model_name} ({model_id})...")
            
            # Choose appropriate pipeline class
            if model_name in ['flux-schnell', 'flux-dev']:
                pipeline_class = FluxPipeline
            elif model_name == 'sdxl':
                pipeline_class = StableDiffusionXLPipeline
            else:  # sd15
                pipeline_class = DiffusionPipeline
            
            # Download and cache the model
            pipeline = pipeline_class.from_pretrained(
                model_id,
                torch_dtype=torch_dtype,
                use_safetensors=True,
                cache_dir="/app/models"
            )
            
            # Save to local directory for faster loading
            model_save_path = f"/app/models/{model_name}"
            pipeline.save_pretrained(model_save_path)
            
            print(f"✅ Successfully downloaded and saved {model_name}")
            success_count += 1
            
            # Clean up to save memory
            del pipeline
            
        except Exception as e:
            print(f"❌ Failed to download {model_name}: {e}")
            failed_models.append(f"{model_name} ({e})")
    
    print(f"\n📊 Download summary:")
    print(f"✅ Successfully downloaded: {success_count} model(s)")
    
    if failed_models:
        print(f"❌ Failed downloads: {len(failed_models)} model(s)")
        for failed in failed_models:
            print(f"   - {failed}")
        
        # Don't fail build if at least one model downloaded successfully
        if success_count == 0:
            print("❌ No models were downloaded successfully. Build failed.")
            sys.exit(1)
        else:
            print("⚠️ Some models failed to download, but at least one succeeded. Build will continue.")
    
    print("\n🎉 Model download process completed!")

if __name__ == "__main__":
    main()