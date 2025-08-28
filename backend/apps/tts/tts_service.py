#!/usr/bin/env python3
"""
TTS Service
Handles text-to-speech using either Piper or Higgs models via vLLM
"""

import os
import base64
import tempfile
import logging
import asyncio
import httpx
from typing import Dict, Any, Optional
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import subprocess
import io
import time

# Always bring in piper even if not using it
import torch  # Import torch only for Piper
import piper
piper_model = piper.PiperVoice.load(
    model_path="/app/models/piper/en_US-amy-low.onnx",
    config_path="/app/models/piper/en_US-amy-low.onnx.json"
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Import pydub after logger configuration
try:
    from pydub import AudioSegment
    logger.info("Successfully imported pydub.AudioSegment")
except ImportError as e:
    logger.error(f"Failed to import pydub.AudioSegment: {e}")
    AudioSegment = None

# Use lifespan context manager for newer FastAPI versions
from contextlib import asynccontextmanager

# Global variables for model state
VOICE_MODEL = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for FastAPI"""
    global piper_model, VOICE_MODEL
    
    logger.info("Starting TTS service...")
    
    # Initialize models based on environment variable
    VOICE_MODEL = os.getenv("VOICE_MODEL", "higgs-vllm").lower()
    logger.info(f"TTS Engine configured: {VOICE_MODEL}")

    # Initialize Piper model if needed
    if VOICE_MODEL == "piper":
        logger.info("Piper TTS model loaded successfully")
    elif VOICE_MODEL in ["higgs", "vllm-higgs"]:
        logger.info(f"Using Higgs Audio {'vLLM container' if VOICE_MODEL == 'vllm-higgs' else 'local model'} - no local model loading required")
    else:
        logger.warning(f"Unknown VOICE_MODEL: {VOICE_MODEL}. Using vllm-higgs as fallback.")
        VOICE_MODEL = "vllm-higgs"
    
    logger.info("TTS service started successfully")
    yield
    logger.info("TTS service shutting down...")

# Initialize FastAPI app
app = FastAPI(title="TTS Service", version="1.0.0", lifespan=lifespan)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models
class TTSRequest(BaseModel):
    text: str
    speed: float = 1.0
    voice_id: str = "default"
    enable_diarization: bool = True  # New option, enabled by default

class TTSResponse(BaseModel):
    audio_data: str  # base64 encoded audio
    duration: float
    sample_rate: int
    voice_used: str
    audio_format: str  # "wav" or "mp3"
    diarization: Optional[Dict[str, Any]] = None  # Diarization results

async def call_stt_diarization(audio_bytes: bytes, sample_rate: int = 16000) -> Dict[str, Any]:
    """Call STT service for diarization"""
    try:
        logger.info("Calling STT service for diarization...")
        
        # Convert audio to base64
        audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
        
        # Make request to STT service
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "http://stt:9001/transcribe",
                json={
                    "audio_data": audio_base64,
                    "sample_rate": sample_rate,
                    "language": "en",
                    "enable_diarization": True
                },
                timeout=30.0
            )
            
            if response.status_code != 200:
                logger.error(f"STT diarization request failed: {response.status_code}")
                return None
            
            result = response.json()
            logger.info("STT diarization request successful")
            
            # Extract relevant diarization data
            return {
                "text": result.get("text", ""),
                "segments": result.get("segments", []),
                "speakers": result.get("speakers", []),
                "confidence": result.get("confidence")
            }
            
    except Exception as e:
        logger.error(f"Error calling STT diarization: {e}")
        return None

def convert_audio_to_mp3(audio_bytes: bytes, sample_rate: int = 22050) -> bytes:
    """Convert audio bytes to MP3 format"""
    try:
        if AudioSegment is None:
            logger.warning("pydub not available, returning original format")
            return audio_bytes
        
        # Create AudioSegment from audio bytes (assuming WAV format)
        audio = AudioSegment.from_wav(io.BytesIO(audio_bytes))
        
        # Export as MP3
        mp3_buffer = io.BytesIO()
        audio.export(mp3_buffer, format="mp3", bitrate="128k")
        mp3_bytes = mp3_buffer.getvalue()
        
        logger.info(f"Converted audio ({len(audio_bytes)} bytes) to MP3 ({len(mp3_bytes)} bytes)")
        return mp3_bytes
        
    except Exception as e:
        logger.error(f"Error converting audio to MP3: {e}")
        return audio_bytes

async def generate_higgs_audio(text: str) -> bytes:
    """Generate audio using Higgs Audio vLLM container"""
    try:
        logger.info(f"Generating Higgs audio for text: {text[:100]}...")
        
        # Make request to Higgs Audio vLLM container
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "http://higgs-audio-vllm:8000/v1/chat/completions",
                json={
                    "model": "higgs-audio-v2-generation-3B-base",
                    "messages": [
                        {
                            "role": "user",
                            "content": text
                        }
                    ],
                    "max_tokens": 2048
                },
                timeout=30.0
            )
            
            if response.status_code != 200:
                logger.error(f"Higgs Audio vLLM request failed: {response.status_code}")
                raise Exception(f"Higgs Audio vLLM request failed: {response.status_code}")
            
            result = response.json()
            logger.info("Higgs Audio vLLM request successful")
            
            # Extract audio data from response
            if "choices" in result and len(result["choices"]) > 0:
                choice = result["choices"][0]
                if "message" in choice and "audio" in choice["message"]:
                    audio_data = choice["message"]["audio"]["data"]
                    # Decode base64 audio data
                    audio_bytes = base64.b64decode(audio_data)
                    logger.info(f"Generated Higgs audio: {len(audio_bytes)} bytes")
                    return audio_bytes
                else:
                    logger.error("No audio data found in Higgs Audio vLLM response")
                    raise Exception("No audio data found in Higgs Audio vLLM response")
            else:
                logger.error("Invalid response format from Higgs Audio vLLM")
                raise Exception("Invalid response format from Higgs Audio vLLM")
                
    except Exception as e:
        logger.error(f"Error generating Higgs audio: {e}")
        raise

def generate_piper_audio(text: str, speed: float = 1.0) -> bytes:
    """Generate audio using Piper TTS - v1.3"""
    global piper_model
    
    if piper_model is None:
        raise Exception("Piper model not loaded")
    
    try:
        logger.info(f"Generating Piper audio for text: {text[:100]}...")
        
        # Generate audio using Piper
        audio_data = piper_model.synthesize(text)
        
        # Convert to WAV format
        wav_bytes = io.BytesIO()
        import soundfile as sf
        sf.write(wav_bytes, audio_data, piper_model.config.sample_rate, format='WAV')
        wav_bytes.seek(0)
        
        audio_bytes = wav_bytes.read()
        logger.info(f"Generated Piper audio: {len(audio_bytes)} bytes")
        return audio_bytes
        
    except Exception as e:
        logger.error(f"Error generating Piper audio: {e}")
        raise

@app.post("/tts", response_model=TTSResponse)
async def text_to_speech(request: TTSRequest):
    """Convert text to speech"""
    try:
        logger.info(f"TTS request received: {request.text[:50]}...")
        
        # Generate audio based on model
        if VOICE_MODEL in ["higgs", "vllm-higgs"]:
            audio_bytes = await generate_higgs_audio(request.text)
            sample_rate = 22050  # Higgs default sample rate
            voice_used = VOICE_MODEL
        elif VOICE_MODEL == "piper":
            audio_bytes = generate_piper_audio(request.text)
            sample_rate = 22050  # Piper default sample rate
            voice_used = "piper"
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported voice model: {VOICE_MODEL}")
        
        # Convert to MP3 for better browser compatibility
        audio_bytes_final = convert_audio_to_mp3(audio_bytes, sample_rate)
        audio_format = "mp3" if len(audio_bytes_final) != len(audio_bytes) else "wav"
        
        # Convert to base64
        audio_base64 = base64.b64encode(audio_bytes_final).decode('utf-8')
        
        # Calculate duration (approximate)
        duration = len(audio_bytes) / (sample_rate * 2)  # 2 bytes per sample for 16-bit
        
        # Call STT diarization if enabled
        diarization_results = None
        if request.enable_diarization:
            diarization_results = await call_stt_diarization(audio_bytes, sample_rate)
        
        return TTSResponse(
            audio_data=audio_base64,
            duration=duration,
            sample_rate=sample_rate,
            voice_used=voice_used,
            audio_format=audio_format,
            diarization=diarization_results
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"TTS error: {e}")
        raise HTTPException(status_code=500, detail=f"TTS failed: {str(e)}")

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy - v1.3",
        "voice_model": VOICE_MODEL,
        "piper_loaded": piper_model is not None if VOICE_MODEL == "piper" else None
    }

@app.get("/models")
async def get_models():
    """Get available models info"""
    return {
        "voice_model": VOICE_MODEL,
        "available_models": ["piper", "higgs", "vllm-higgs"],
        "piper_loaded": piper_model is not None if VOICE_MODEL == "piper" else None
    }

@app.get("/voices")
async def get_voices():
    """Get available voices"""
    if VOICE_MODEL == "piper":
        return {
            "voices": [
                {
                    "id": "en_US-amy-low",
                    "name": "Amy (Low Quality)",
                    "language": "en-US",
                    "gender": "female"
                }
            ]
        }
    elif VOICE_MODEL in ["higgs", "vllm-higgs"]:
        return {
            "voices": [
                {
                    "id": "default",
                    "name": f"Default Higgs Voice ({'vLLM' if VOICE_MODEL == 'vllm-higgs' else 'Local'})",
                    "language": "en",
                    "gender": "neutral"
                }
            ]
        }
    else:
        return {"voices": []}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=9002)
