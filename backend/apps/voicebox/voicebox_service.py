#!/usr/bin/env python3
"""
Voicebox Service - Voice Cloning and Custom TTS
Provides voice cloning capabilities using pre-trained models
"""

import base64
import json
import logging
import os
import struct
from pathlib import Path
from typing import Optional, List
from datetime import datetime

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global variables
MODELS_DIR = Path("/app/models")
VOICES_DIR = MODELS_DIR / "voices"
BASE_MODELS_DIR = MODELS_DIR / "base"

# Ensure directories exist
VOICES_DIR.mkdir(parents=True, exist_ok=True)
BASE_MODELS_DIR.mkdir(parents=True, exist_ok=True)

# Voice profiles database (in-memory for now, should be DB-backed in production)
voice_profiles = {}


class VoiceProfile(BaseModel):
    """Voice profile metadata"""
    id: str
    name: str
    description: Optional[str] = None
    language: str = "en"
    sample_count: int = 0
    created_at: str
    updated_at: str


class VoiceSample(BaseModel):
    """Voice sample metadata"""
    id: str
    profile_id: str
    filename: str
    duration: Optional[float] = None
    sample_rate: int = 22050
    uploaded_at: str


class CreateProfileRequest(BaseModel):
    """Request to create a new voice profile"""
    name: str
    description: Optional[str] = None
    language: str = "en"


class SynthesizeRequest(BaseModel):
    """Request to synthesize speech with custom voice"""
    text: str
    voice_id: str
    speed: float = 1.0


class SynthesizeResponse(BaseModel):
    """Response from synthesis"""
    audio: str  # Base64 encoded audio
    sample_rate: int
    duration: Optional[float] = None


def create_wav_file(audio_data: np.ndarray, sample_rate: int = 22050) -> bytes:
    """Create a proper WAV file with headers from audio data"""
    # Ensure audio_data is 16-bit integers
    if audio_data.dtype != np.int16:
        audio_data = (audio_data * 32767).astype(np.int16)
    
    # Convert to bytes
    audio_bytes = audio_data.tobytes()
    
    # WAV file header
    num_channels = 1  # Mono
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(audio_bytes)
    file_size = 36 + data_size
    
    # Create WAV header
    wav_header = struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF',                    # ChunkID
        file_size,                  # ChunkSize
        b'WAVE',                    # Format
        b'fmt ',                    # Subchunk1ID
        16,                         # Subchunk1Size (PCM)
        1,                          # AudioFormat (PCM)
        num_channels,               # NumChannels
        sample_rate,                # SampleRate
        byte_rate,                  # ByteRate
        block_align,                # BlockAlign
        bits_per_sample,            # BitsPerSample
        b'data',                    # Subchunk2ID
        data_size                   # Subchunk2Size
    )
    
    return wav_header + audio_bytes


def generate_id() -> str:
    """Generate a simple unique ID"""
    import uuid
    return str(uuid.uuid4())


# Initialize FastAPI app
app = FastAPI(
    title="Voicebox Service",
    version="1.0.0",
    description="Voice cloning and custom TTS service"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/voicebox/profile/create", response_model=VoiceProfile)
async def create_profile(request: CreateProfileRequest):
    """
    Create a new voice profile for cloning.
    """
    try:
        profile_id = generate_id()
        now = datetime.utcnow().isoformat()
        
        profile = VoiceProfile(
            id=profile_id,
            name=request.name,
            description=request.description,
            language=request.language,
            sample_count=0,
            created_at=now,
            updated_at=now
        )
        
        # Create profile directory
        profile_dir = VOICES_DIR / profile_id
        profile_dir.mkdir(exist_ok=True)
        
        # Save profile metadata
        with open(profile_dir / "profile.json", "w") as f:
            json.dump(profile.dict(), f, indent=2)
        
        # Store in memory
        voice_profiles[profile_id] = profile
        
        logger.info(f"Created voice profile: {profile.name} (ID: {profile_id})")
        return profile
        
    except Exception as e:
        logger.error(f"Failed to create profile: {e}")
        raise HTTPException(status_code=500, detail=f"Profile creation failed: {str(e)}")


@app.post("/voicebox/sample/upload")
async def upload_sample(
    profile_id: str = Form(...),
    audio_file: UploadFile = File(...)
):
    """
    Upload a voice sample for a profile.
    Samples are used to train/clone the voice.
    """
    try:
        # Check if profile exists
        profile_dir = VOICES_DIR / profile_id
        if not profile_dir.exists():
            raise HTTPException(status_code=404, detail=f"Profile not found: {profile_id}")
        
        # Read audio file
        audio_data = await audio_file.read()
        
        # Generate sample ID
        sample_id = generate_id()
        sample_filename = f"{sample_id}.wav"
        sample_path = profile_dir / sample_filename
        
        # Save audio file
        with open(sample_path, "wb") as f:
            f.write(audio_data)
        
        # Get audio duration
        try:
            data, samplerate = sf.read(sample_path)
            duration = len(data) / samplerate
        except Exception as e:
            logger.warning(f"Could not read audio duration: {e}")
            duration = None
        
        # Create sample metadata
        sample = VoiceSample(
            id=sample_id,
            profile_id=profile_id,
            filename=sample_filename,
            duration=duration,
            sample_rate=samplerate if duration else 22050,
            uploaded_at=datetime.utcnow().isoformat()
        )
        
        # Update profile sample count
        profile_file = profile_dir / "profile.json"
        with open(profile_file, "r") as f:
            profile_data = json.load(f)
        
        profile_data["sample_count"] += 1
        profile_data["updated_at"] = datetime.utcnow().isoformat()
        
        with open(profile_file, "w") as f:
            json.dump(profile_data, f, indent=2)
        
        # Update in-memory cache
        if profile_id in voice_profiles:
            voice_profiles[profile_id].sample_count += 1
            voice_profiles[profile_id].updated_at = profile_data["updated_at"]
        
        logger.info(f"Uploaded sample {sample_id} for profile {profile_id}")
        
        return {
            "status": "success",
            "sample": sample.dict(),
            "message": f"Sample uploaded successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload sample: {e}")
        raise HTTPException(status_code=500, detail=f"Sample upload failed: {str(e)}")


@app.get("/voicebox/voices")
async def list_voices():
    """
    List all available voice profiles.
    """
    try:
        profiles = []
        
        # Scan voice directories
        for profile_dir in VOICES_DIR.iterdir():
            if profile_dir.is_dir():
                profile_file = profile_dir / "profile.json"
                if profile_file.exists():
                    with open(profile_file, "r") as f:
                        profile_data = json.load(f)
                        profiles.append(profile_data)
                        
                        # Update in-memory cache
                        profile_id = profile_data["id"]
                        if profile_id not in voice_profiles:
                            voice_profiles[profile_id] = VoiceProfile(**profile_data)
        
        return {
            "status": "success",
            "voices": profiles,
            "count": len(profiles)
        }
        
    except Exception as e:
        logger.error(f"Failed to list voices: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list voices: {str(e)}")


@app.post("/voicebox/synthesize", response_model=SynthesizeResponse)
async def synthesize_speech(request: SynthesizeRequest):
    """
    Synthesize speech using a custom cloned voice.
    
    Note: This is a placeholder implementation.
    In production, this would use actual voice cloning models.
    For now, it returns a simple tone to demonstrate the API structure.
    """
    try:
        # Check if voice profile exists
        profile_dir = VOICES_DIR / request.voice_id
        if not profile_dir.exists():
            raise HTTPException(status_code=404, detail=f"Voice profile not found: {request.voice_id}")
        
        logger.info(f"Synthesizing text with voice {request.voice_id}: '{request.text[:50]}...'")
        
        # PLACEHOLDER: Generate simple audio (sine wave tone)
        # In production, this would use actual TTS with voice cloning
        sample_rate = 22050
        duration = max(1.0, len(request.text) / 20)  # Rough estimate
        
        # Generate a simple tone (placeholder for actual synthesis)
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        tone = np.sin(2 * np.pi * 440 * t)  # 440 Hz tone
        
        # Convert to 16-bit PCM
        audio_data = (tone * 32767).astype(np.int16)
        
        # Create WAV file
        wav_data = create_wav_file(audio_data, sample_rate)
        
        # Encode to base64
        audio_base64 = base64.b64encode(wav_data).decode('utf-8')
        
        logger.info(f"Synthesis completed. Duration: {duration:.2f}s")
        
        return SynthesizeResponse(
            audio=audio_base64,
            sample_rate=sample_rate,
            duration=duration
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Synthesis error: {e}")
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {str(e)}")


@app.delete("/voicebox/profile/{profile_id}")
async def delete_profile(profile_id: str):
    """
    Delete a voice profile and all its samples.
    """
    try:
        profile_dir = VOICES_DIR / profile_id
        if not profile_dir.exists():
            raise HTTPException(status_code=404, detail=f"Profile not found: {profile_id}")
        
        # Delete directory and all contents
        import shutil
        shutil.rmtree(profile_dir)
        
        # Remove from memory
        if profile_id in voice_profiles:
            del voice_profiles[profile_id]
        
        logger.info(f"Deleted voice profile: {profile_id}")
        
        return {
            "status": "success",
            "message": f"Profile {profile_id} deleted successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete profile: {e}")
        raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "voicebox",
        "voice_profiles": len(voice_profiles)
    }


@app.get("/")
async def root():
    """Root endpoint with service information"""
    return {
        "service": "Voicebox Service",
        "version": "1.0.0",
        "endpoints": {
            "create_profile": "/voicebox/profile/create",
            "upload_sample": "/voicebox/sample/upload",
            "list_voices": "/voicebox/voices",
            "synthesize": "/voicebox/synthesize",
            "delete_profile": "/voicebox/profile/{profile_id}",
            "health": "/health"
        }
    }


# Load existing profiles on startup
@app.on_event("startup")
async def startup_event():
    """Load existing voice profiles on startup"""
    logger.info("Starting Voicebox service...")
    
    # Load profiles from disk
    for profile_dir in VOICES_DIR.iterdir():
        if profile_dir.is_dir():
            profile_file = profile_dir / "profile.json"
            if profile_file.exists():
                try:
                    with open(profile_file, "r") as f:
                        profile_data = json.load(f)
                        profile_id = profile_data["id"]
                        voice_profiles[profile_id] = VoiceProfile(**profile_data)
                        logger.info(f"Loaded profile: {profile_data['name']} (ID: {profile_id})")
                except Exception as e:
                    logger.error(f"Failed to load profile from {profile_dir}: {e}")
    
    logger.info(f"Voicebox service started. Loaded {len(voice_profiles)} voice profiles.")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=9003)
