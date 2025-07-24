#!/usr/bin/env python3
"""
WhisperX Voice Processing Service
Handles real-time speech-to-text transcription using WhisperX
"""

import os
import base64
import tempfile
import logging
from typing import Dict, Any, Optional
from pathlib import Path

import torch
import whisperx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import subprocess
import io

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(title="WhisperX Voice Service", version="1.0.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for model and device
model = None
device = None
compute_type = None

class TranscriptionRequest(BaseModel):
    audio_data: str  # Base64 encoded audio
    sample_rate: int = 16000
    language: str = "en"
    model_size: str = "base"

class TranscriptionResponse(BaseModel):
    text: str
    segments: list
    language: str
    confidence: float

def convert_audio_to_wav(audio_data: bytes, input_format: str = "webm") -> bytes:
    """Convert audio data to WAV format using ffmpeg"""
    try:
        # Create temporary input file
        with tempfile.NamedTemporaryFile(suffix=f".{input_format}", delete=False) as input_file:
            input_file.write(audio_data)
            input_path = input_file.name
        
        # Create temporary output file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output_file:
            output_path = output_file.name
        
        try:
            # Convert using ffmpeg
            cmd = [
                "ffmpeg", "-y",  # Overwrite output file
                "-i", input_path,  # Input file
                "-acodec", "pcm_s16le",  # 16-bit PCM
                "-ar", "16000",  # 16kHz sample rate
                "-ac", "1",  # Mono
                "-f", "wav",  # WAV format
                output_path  # Output file
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0:
                logger.error(f"FFmpeg conversion failed: {result.stderr}")
                # Fall back to original audio data
                return audio_data
            
            # Read converted audio
            with open(output_path, "rb") as f:
                wav_data = f.read()
            
            logger.info(f"Audio converted: {len(audio_data)} -> {len(wav_data)} bytes")
            return wav_data
            
        finally:
            # Clean up temporary files
            os.unlink(input_path)
            os.unlink(output_path)
            
    except Exception as e:
        logger.error(f"Audio conversion failed: {str(e)}")
        # Fall back to original audio data
        return audio_data

def load_whisperx_model(model_size: str = "base") -> tuple:
    """Load WhisperX model with specified size"""
    global model, device, compute_type
    
    if model is not None:
        return model, device, compute_type
    
    logger.info(f"Loading WhisperX model: {model_size}")
    
    # Set device
    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    
    logger.info(f"Using device: {device}, compute type: {compute_type}")
    
    # Load model
    model = whisperx.load_model(
        model_size, 
        device, 
        compute_type=compute_type,
        language="en"
    )
    
    logger.info("WhisperX model loaded successfully")
    return model, device, compute_type

def transcribe_audio(audio_data: bytes, sample_rate: int = 16000, language: str = "en") -> Dict[str, Any]:
    """Transcribe audio data using WhisperX with improved sensitivity"""
    try:
        # Load model if not already loaded
        model, device, compute_type = load_whisperx_model()
        
        logger.info(f"Processing audio: {len(audio_data)} bytes, sample_rate: {sample_rate}")
        
        # Convert audio to WAV format if needed
        wav_audio_data = convert_audio_to_wav(audio_data, "webm")
        
        # Create temporary file for audio
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            temp_file.write(wav_audio_data)
            temp_file_path = temp_file.name
        
        try:
            # Load audio
            audio = whisperx.load_audio(temp_file_path, sample_rate)
            logger.info(f"Audio loaded: {len(audio)} samples, duration: {len(audio)/sample_rate:.2f}s")
            
            # Check if audio has content (not just silence) - 100x more sensitive
            audio_rms = np.sqrt(np.mean(audio**2))
            logger.info(f"Audio RMS level: {audio_rms:.6f}")
            
            if audio_rms < 0.00001:  # 100x more sensitive threshold (like the C++ example)
                logger.warning("Audio appears to be silence or very quiet")
                return {
                    "text": "",
                    "segments": [],
                    "language": language,
                    "confidence": 0.0
                }
            
            # Transcribe with 10x more sensitive settings
            result = model.transcribe(
                audio, 
                batch_size=1,  # Smaller batch size for better real-time processing
                condition_on_previous_text=False,  # Don't condition on previous text for better sensitivity
                initial_prompt=None,  # No initial prompt for better sensitivity
                temperature=0.0,  # Lower temperature for more consistent results
                compression_ratio_threshold=0.5,  # 10x more permissive threshold
                logprob_threshold=-3.0,  # 10x more permissive threshold
                no_speech_threshold=0.01,  # 10x more permissive threshold
            )
            
            logger.info(f"Transcription result: '{result['text']}'")
            
            # Only align if we have segments
            if result["segments"]:
                # Align timestamps
                model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
                result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
            
            # Calculate confidence
            if result["segments"]:
                confidence = np.mean([seg.get("avg_logprob", 0.0) for seg in result["segments"]])
            else:
                confidence = 0.0
            
            return {
                "text": result["text"],
                "segments": result["segments"],
                "language": result["language"],
                "confidence": float(confidence)
            }
            
        finally:
            # Clean up temporary file
            os.unlink(temp_file_path)
            
    except Exception as e:
        logger.error(f"Error transcribing audio: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_endpoint(request: TranscriptionRequest):
    """Transcribe audio endpoint"""
    try:
        # Decode base64 audio
        audio_data = base64.b64decode(request.audio_data)
        
        # Transcribe
        result = transcribe_audio(
            audio_data, 
            sample_rate=request.sample_rate,
            language=request.language
        )
        
        return TranscriptionResponse(**result)
        
    except Exception as e:
        logger.error(f"Error in transcribe endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "device": device, "model_loaded": model is not None}

@app.get("/models")
async def list_models():
    """List available model sizes"""
    return {
        "models": ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        "current_model": "base"
    }

@app.post("/debug-audio")
async def debug_audio(request: TranscriptionRequest):
    """Debug endpoint to test audio processing without transcription"""
    try:
        # Decode base64 audio
        audio_data = base64.b64decode(request.audio_data)
        
        logger.info(f"Debug audio: {len(audio_data)} bytes")
        
        # Convert audio to WAV format
        wav_audio_data = convert_audio_to_wav(audio_data, "webm")
        
        # Load audio and check properties
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            temp_file.write(wav_audio_data)
            temp_file_path = temp_file.name
        
        try:
            audio = whisperx.load_audio(temp_file_path, request.sample_rate)
            audio_rms = np.sqrt(np.mean(audio**2))
            
            return {
                "original_size": len(audio_data),
                "wav_size": len(wav_audio_data),
                "audio_samples": len(audio),
                "duration_seconds": len(audio) / request.sample_rate,
                "rms_level": float(audio_rms),
                "has_content": audio_rms > 0.001
            }
        finally:
            os.unlink(temp_file_path)
            
    except Exception as e:
        logger.error(f"Error in debug audio endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    # Load model on startup
    try:
        load_whisperx_model()
        logger.info("WhisperX service started successfully")
    except Exception as e:
        logger.error(f"Failed to load WhisperX model: {str(e)}")
        exit(1)
    
    # Run server
    uvicorn.run(app, host="0.0.0.0", port=9001) 