#!/usr/bin/env python3
"""
Whisper STT Service
Handles real-time speech-to-text transcription using OpenAI Whisper
"""

import os
import base64
import tempfile
import logging
import asyncio
from typing import Dict, Any, Optional
from pathlib import Path

import torch
import whisper
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import subprocess
import io
import time

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Use lifespan context manager for newer FastAPI versions
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for FastAPI"""
    logger.info("Starting STT service...")
    
    # Load Whisper model
    if not load_whisper_model():
        logger.error("Failed to load Whisper model. Service may not function properly.")
    
    logger.info("STT service started successfully")
    yield
    logger.info("STT service shutting down...")

# Initialize FastAPI app
app = FastAPI(title="Whisper STT Service", version="1.0.0", lifespan=lifespan)

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

# Session management for streaming audio
audio_sessions = {}  # session_id -> {audio_buffer, last_transcription, start_time, last_process_time, window_size}

# Background processing queue
processing_queue = asyncio.Queue()
processing_tasks = {}  # session_id -> task

# Configuration for streaming optimization
STREAMING_CONFIG = {
    'min_window_size': 4000,   # 0.25 seconds of audio at 16kHz
    'max_window_size': 32000,  # 2 seconds of audio at 16kHz
    'process_interval': 0.25,  # Process every 0.25 seconds
    'overlap_size': 2000,      # 0.125 seconds overlap to maintain context
    'silence_threshold': 0.0001,  # RMS threshold for silence detection
    'chunk_timeout': 30.0,     # Clean up sessions after 30 seconds of inactivity
    'max_concurrent_processing': 2,  # Maximum concurrent processing tasks
    'streaming_buffer_size': 16000,  # 1 second buffer for streaming
}

# Real-time streaming sessions
streaming_sessions = {}  # session_id -> {audio_buffer, partial_text, segments, last_update}

def cleanup_expired_sessions():
    """Clean up expired audio and streaming sessions"""
    current_time = time.time()
    expired_audio_sessions = []
    expired_streaming_sessions = []
    
    # Clean up audio sessions
    for session_id, session in audio_sessions.items():
        if current_time - session.get('last_activity', 0) > STREAMING_CONFIG['chunk_timeout']:
            expired_audio_sessions.append(session_id)
    
    for session_id in expired_audio_sessions:
        del audio_sessions[session_id]
        logger.info(f"Cleaned up expired audio session: {session_id}")
    
    # Clean up streaming sessions
    for session_id, session in streaming_sessions.items():
        if current_time - session.get('last_update', 0) > STREAMING_CONFIG['chunk_timeout']:
            expired_streaming_sessions.append(session_id)
    
    for session_id in expired_streaming_sessions:
        del streaming_sessions[session_id]
        logger.info(f"Cleaned up expired streaming session: {session_id}")

def load_whisper_model():
    """Load Whisper model with optimized settings"""
    global model, device
    
    try:
        # Determine device and compute type
        if torch.cuda.is_available():
            device = "cuda"
            logger.info("Using CUDA")
        else:
            device = "cpu"
            logger.info("Using CPU")
        
        # Load Whisper model
        logger.info(f"Loading Whisper model: base")
        model = whisper.load_model("base", device)
        logger.info("Whisper model loaded successfully")
        
        return True
    except Exception as e:
        logger.error(f"Failed to load Whisper model: {e}")
        return False

# Pydantic models for API
class AudioRequest(BaseModel):
    audio_data: str  # Base64 encoded audio
    session_id: Optional[str] = None
    language: Optional[str] = "en"
    sample_rate: Optional[int] = 16000
    model_size: Optional[str] = "base"
    enable_diarization: Optional[bool] = False

class TranscriptionResponse(BaseModel):
    text: str
    session_id: str
    confidence: Optional[float] = None
    segments: Optional[list] = None
    language: Optional[str] = "en"
    speakers: Optional[list] = []

class StreamingAudioRequest(BaseModel):
    audio_chunk: str  # Base64 encoded audio chunk
    session_id: str
    is_final: bool = False
    sample_rate: Optional[int] = 16000
    language: Optional[str] = "en"
    model_size: Optional[str] = "base"
    enable_diarization: Optional[bool] = False

class StreamingResponse(BaseModel):
    partial_text: str
    is_final: bool
    session_id: str



@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_audio(request: AudioRequest):
    """Transcribe audio data with Whisper (word-level timestamps)"""
    
    try:
        # Decode base64 audio
        audio_bytes = base64.b64decode(request.audio_data)
        
        # Save to temporary file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            temp_file.write(audio_bytes)
            temp_file_path = temp_file.name
        
        try:
            # Load audio with Whisper
            audio = whisper.load_audio(temp_file_path)
            
            # Transcribe with Whisper
            result = model.transcribe(audio, language=request.language)
            
            # Extract text
            text = result["text"].strip()
            
            return TranscriptionResponse(
                text=text,
                session_id=request.session_id or "default",
                segments=result.get("segments", []),
                language=result.get("language", "en"),
                confidence=result.get("confidence", None),
                speakers=result.get("speakers", [])
            )
            
        finally:
            # Clean up temporary file
            os.unlink(temp_file_path)
            
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.post("/transcribe-stream")
async def transcribe_stream(request: StreamingAudioRequest):
    """Handle streaming audio transcription"""
    try:
        # Decode audio chunk
        audio_bytes = base64.b64decode(request.audio_chunk)
        
        # Convert to numpy array
        audio_data = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        
        # Initialize or update session
        if request.session_id not in streaming_sessions:
            streaming_sessions[request.session_id] = {
                'audio_buffer': [],
                'partial_text': '',
                'segments': [],
                'last_update': time.time()
            }
        
        session = streaming_sessions[request.session_id]
        session['audio_buffer'].extend(audio_data)
        session['last_update'] = time.time()
        
        # Process if we have enough audio or it's final
        if len(session['audio_buffer']) >= STREAMING_CONFIG['min_window_size'] or request.is_final:
            # Convert buffer to audio
            audio_array = np.array(session['audio_buffer'])
            
            # Save to temporary file
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
                import soundfile as sf
                sf.write(temp_file.name, audio_array, request.sample_rate or 16000)
                temp_file_path = temp_file.name
            
            try:
                # Transcribe
                audio = whisper.load_audio(temp_file_path)
                result = model.transcribe(audio, language=request.language or "en")
                
                # Update partial text
                if result["text"]:
                    session['partial_text'] = result["text"].strip()
                    session['segments'] = result.get("segments", [])
                
                # Clear buffer if final
                if request.is_final:
                    session['audio_buffer'] = []
                
            finally:
                os.unlink(temp_file_path)
        
        return StreamingResponse(
            partial_text=session['partial_text'],
            is_final=request.is_final,
            session_id=request.session_id
        )
        
    except Exception as e:
        logger.error(f"Streaming transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Streaming transcription failed: {str(e)}")

@app.post("/transcribe-stream-final")
async def finalize_streaming_transcription(request: StreamingAudioRequest):
    """Finalize streaming transcription"""
    return await transcribe_stream(StreamingAudioRequest(
        audio_chunk=request.audio_chunk,
        session_id=request.session_id,
        is_final=True
    ))



@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "model_loaded": model is not None,
        "device": device,
        "compute_type": None,
        "diarization_available": False
    }

@app.get("/models")
async def get_models():
    """Get available models info"""
    return {
        "whisper_model": "base" if model else None,
        "diarization_model": None,
        "device": device,
        "compute_type": None
    }

@app.post("/cleanup-sessions")
async def cleanup_sessions():
    """Manually trigger session cleanup"""
    cleanup_expired_sessions()
    return {"message": "Sessions cleaned up", "active_sessions": len(streaming_sessions)}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=9001)
