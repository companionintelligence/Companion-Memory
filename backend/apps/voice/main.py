#!/usr/bin/env python3
"""
WhisperX Voice Service
A FastAPI service for real-time speech-to-text transcription using WhisperX
"""

import os
import asyncio
import tempfile
import base64
from typing import Optional, Dict, Any
from pathlib import Path

import whisperx
import torch
import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from loguru import logger
import soundfile as sf
from pydub import AudioSegment
import io

# Configure logging
logger.add("logs/voice_service.log", rotation="10 MB", level="INFO")

app = FastAPI(
    title="WhisperX Voice Service",
    description="Real-time speech-to-text transcription service using WhisperX",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for model management
whisper_model = None
align_model = None
device = "cpu"  # Change to "cuda" for GPU support
compute_type = "int8"  # Use "float16" for better accuracy if GPU available

class TranscriptionRequest(BaseModel):
    audio_data: str  # Base64 encoded audio
    sample_rate: int = 16000
    language: Optional[str] = "en"
    model_size: str = "base"  # tiny, base, small, medium, large, large-v2, large-v3

class TranscriptionResponse(BaseModel):
    text: str
    segments: list
    language: str
    confidence: float
    processing_time: float

class StreamRequest(BaseModel):
    session_id: str
    audio_chunk: str  # Base64 encoded audio chunk
    sample_rate: int = 16000
    is_final: bool = False

class StreamResponse(BaseModel):
    session_id: str
    text: str
    is_final: bool
    confidence: float
    timestamp: float

# In-memory storage for active sessions
active_sessions: Dict[str, Dict[str, Any]] = {}

def load_whisper_model(model_size: str = "base"):
    """Load WhisperX model"""
    global whisper_model, device, compute_type
    
    try:
        logger.info(f"Loading WhisperX model: {model_size}")
        whisper_model = whisperx.load_model(
            model_size, 
            device, 
            compute_type=compute_type,
            language="en"
        )
        logger.info(f"WhisperX model {model_size} loaded successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to load WhisperX model: {e}")
        return False

def load_align_model(language_code: str = "en"):
    """Load alignment model for timestamp accuracy"""
    global align_model, device
    
    try:
        logger.info(f"Loading alignment model for language: {language_code}")
        align_model, metadata = whisperx.load_align_model(
            language_code=language_code, 
            device=device
        )
        logger.info(f"Alignment model loaded successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to load alignment model: {e}")
        return False

def audio_base64_to_numpy(audio_base64: str, sample_rate: int = 16000) -> np.ndarray:
    """Convert base64 audio to numpy array"""
    try:
        # Decode base64
        audio_bytes = base64.b64decode(audio_base64)
        
        # Convert to audio segment
        audio_segment = AudioSegment.from_file(io.BytesIO(audio_bytes), format="webm")
        
        # Convert to mono and set sample rate
        audio_segment = audio_segment.set_channels(1).set_frame_rate(sample_rate)
        
        # Convert to numpy array
        samples = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
        samples = samples / 32768.0  # Normalize to [-1, 1]
        
        return samples
    except Exception as e:
        logger.error(f"Error converting base64 audio to numpy: {e}")
        raise HTTPException(status_code=400, detail=f"Invalid audio data: {str(e)}")

def transcribe_audio(audio_data: np.ndarray, language: str = "en") -> Dict[str, Any]:
    """Transcribe audio using WhisperX"""
    global whisper_model, align_model
    
    if whisper_model is None:
        if not load_whisper_model():
            raise HTTPException(status_code=500, detail="Failed to load WhisperX model")
    
    try:
        # Transcribe with WhisperX
        result = whisper_model.transcribe(audio_data, batch_size=16)
        
        # Align timestamps if alignment model is available
        if align_model is not None:
            try:
                result = whisperx.align(
                    result["segments"], 
                    align_model, 
                    {"sampling_rate": 16000}, 
                    audio_data, 
                    device,
                    return_char_alignments=False
                )
            except Exception as e:
                logger.warning(f"Alignment failed, using original timestamps: {e}")
        
        return result
    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.on_event("startup")
async def startup_event():
    """Initialize models on startup"""
    logger.info("Starting WhisperX Voice Service...")
    
    # Create logs directory
    os.makedirs("logs", exist_ok=True)
    
    # Load default model
    if not load_whisper_model("base"):
        logger.error("Failed to load default WhisperX model")
    
    # Load alignment model
    if not load_align_model("en"):
        logger.warning("Failed to load alignment model, timestamps may be less accurate")

@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "service": "WhisperX Voice Service",
        "status": "running",
        "model_loaded": whisper_model is not None,
        "align_model_loaded": align_model is not None,
        "device": device
    }

@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_audio_endpoint(request: TranscriptionRequest):
    """Transcribe audio from base64 data"""
    import time
    
    start_time = time.time()
    
    try:
        # Convert base64 audio to numpy array
        audio_data = audio_base64_to_numpy(request.audio_data, request.sample_rate)
        
        # Transcribe audio
        result = transcribe_audio(audio_data, request.language)
        
        processing_time = time.time() - start_time
        
        return TranscriptionResponse(
            text=result.get("text", ""),
            segments=result.get("segments", []),
            language=result.get("language", request.language),
            confidence=result.get("confidence", 0.0),
            processing_time=processing_time
        )
    except Exception as e:
        logger.error(f"Transcription endpoint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stream/start")
async def start_stream_session(request: StreamRequest):
    """Start a new streaming session"""
    session_id = request.session_id
    
    if session_id in active_sessions:
        logger.warning(f"Session {session_id} already exists, overwriting")
    
    active_sessions[session_id] = {
        "audio_chunks": [],
        "current_text": "",
        "start_time": None,
        "language": "en"
    }
    
    logger.info(f"Started streaming session: {session_id}")
    
    return {"session_id": session_id, "status": "started"}

@app.post("/stream/audio/{session_id}")
async def process_audio_chunk(session_id: str, request: StreamRequest):
    """Process audio chunk for streaming transcription"""
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    try:
        # Convert base64 audio to numpy array
        audio_chunk = audio_base64_to_numpy(request.audio_chunk, request.sample_rate)
        
        # Add to session audio chunks
        session["audio_chunks"].append(audio_chunk)
        
        # For real-time processing, we could implement incremental transcription here
        # For now, we'll accumulate chunks and transcribe when final
        
        if request.is_final:
            # Combine all audio chunks
            combined_audio = np.concatenate(session["audio_chunks"])
            
            # Transcribe combined audio
            result = transcribe_audio(combined_audio, session["language"])
            
            # Update session
            session["current_text"] = result.get("text", "")
            
            return StreamResponse(
                session_id=session_id,
                text=session["current_text"],
                is_final=True,
                confidence=result.get("confidence", 0.0),
                timestamp=time.time()
            )
        else:
            # For incremental processing, we could return partial results
            # For now, return empty text for non-final chunks
            return StreamResponse(
                session_id=session_id,
                text="",
                is_final=False,
                confidence=0.0,
                timestamp=time.time()
            )
            
    except Exception as e:
        logger.error(f"Error processing audio chunk for session {session_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stream/stop/{session_id}")
async def stop_stream_session(session_id: str):
    """Stop a streaming session and get final transcription"""
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    try:
        if session["audio_chunks"]:
            # Combine all audio chunks
            combined_audio = np.concatenate(session["audio_chunks"])
            
            # Transcribe combined audio
            result = transcribe_audio(combined_audio, session["language"])
            
            final_text = result.get("text", "")
        else:
            final_text = ""
        
        # Clean up session
        del active_sessions[session_id]
        
        logger.info(f"Stopped streaming session: {session_id}")
        
        return StreamResponse(
            session_id=session_id,
            text=final_text,
            is_final=True,
            confidence=result.get("confidence", 0.0) if session["audio_chunks"] else 0.0,
            timestamp=time.time()
        )
        
    except Exception as e:
        logger.error(f"Error stopping session {session_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/sessions")
async def list_active_sessions():
    """List all active streaming sessions"""
    return {
        "active_sessions": list(active_sessions.keys()),
        "count": len(active_sessions)
    }

@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a streaming session"""
    if session_id in active_sessions:
        del active_sessions[session_id]
        logger.info(f"Deleted session: {session_id}")
        return {"status": "deleted"}
    else:
        raise HTTPException(status_code=404, detail="Session not found")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=9000,
        reload=True,
        log_level="info"
    ) 