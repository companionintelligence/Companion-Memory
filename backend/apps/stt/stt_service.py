#!/usr/bin/env python3
"""
Whisper STT Service
Simple speech-to-text transcription using Whisper
"""

import base64
import logging
import tempfile
import os
from typing import Optional

import torch
import whisper
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global variables for model and device
model = None
device = None

def load_whisper_model():
    """Load Whisper model with optimized settings"""
    global model, device

    try:
        # Determine device
        if torch.cuda.is_available():
            device = "cuda"
            logger.info("Using CUDA for Whisper")
        else:
            device = "cpu"
            logger.info("Using CPU for Whisper")

        # Load Whisper model (using base model for good balance of speed/accuracy)
        logger.info("Loading Whisper model: base")
        model = whisper.load_model("base", device=device)
        logger.info("Whisper model loaded successfully")

        return True
    except Exception as e:
        logger.error(f"Failed to load Whisper model: {e}")
        return False

# Initialize FastAPI app
app = FastAPI(
    title="Whisper STT Service", 
    version="1.0.0",
    description="Simple speech-to-text transcription service using Whisper"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models for API
class TranscribeRequest(BaseModel):
    audio: str  # Base64 encoded audio data
    language: Optional[str] = None  # Auto-detect if not provided
    model_size: Optional[str] = "base"  # Not used in current implementation but kept for API compatibility

class TranscribeResponse(BaseModel):
    text: str
    language: Optional[str] = None
    segments: Optional[list] = None
    words: Optional[list] = None


@app.post("/stt/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(request: TranscribeRequest):
    """
    Transcribe audio data using Whisper.
    
    Args:
        request: Contains base64 encoded audio data and optional language parameter
        
    Returns:
        TranscribeResponse: Contains transcribed text and detected language
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Whisper model not loaded")
    
    try:
        # Decode base64 audio
        audio_bytes = base64.b64decode(request.audio)
        
        # Convert audio bytes to numpy array for Whisper
        # Whisper expects a file path, so we'll write to a temporary file
        logger.info(f"Processing audio data: {len(audio_bytes)} bytes")
        
        # Write audio bytes to a temporary file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as temp_file:
            temp_file.write(audio_bytes)
            temp_file_path = temp_file.name
        
        try:
            # Load audio using Whisper's built-in audio loading
            audio_data = whisper.load_audio(temp_file_path)
        finally:
            # Clean up the temporary file
            os.unlink(temp_file_path)
        
        # Transcribe with Whisper
        result = model.transcribe(
            audio_data,  # Pass numpy array to Whisper
            language=request.language,  # None means auto-detect
            fp16=False,  # Use fp32 for better compatibility
            word_timestamps=True  # Enable word-level timestamps
        )
        
        # Extract text and clean it up
        text = result["text"].strip()
        detected_language = result.get("language", "unknown")
        
        # Extract segments and words with timestamps
        segments = result.get("segments", [])
        words = []
        
        # Flatten all words from all segments
        for segment in segments:
            if "words" in segment:
                words.extend(segment["words"])
        
        logger.info(f"Transcription completed. Language: {detected_language}, Text length: {len(text)}, Words: {len(words)}")
        
        return TranscribeResponse(
            text=text,
            language=detected_language,
            segments=segments,
            words=words
        )
        
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "model_loaded": model is not None,
        "device": device,
        "service": "whisper-stt"
    }

@app.get("/")
async def root():
    """Root endpoint with service information"""
    return {
        "service": "Whisper STT Service",
        "version": "1.0.0",
        "endpoints": {
            "transcribe": "/stt/transcribe",
            "health": "/health"
        }
    }

# Load model on startup
@app.on_event("startup")
async def startup_event():
    """Load Whisper model on startup"""
    logger.info("Starting STT service...")
    if not load_whisper_model():
        logger.error("Failed to load Whisper model. Service may not function properly.")
    logger.info("STT service started successfully")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=9001)