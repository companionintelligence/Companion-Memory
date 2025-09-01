"""
Speech Services API - A unified interface for STT and TTS services
Supports multiple speech engines including Whisper, Piper, and more
"""
import os
import uvicorn
from fastapi import FastAPI, HTTPException, File, UploadFile, Form
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any
import tempfile
import json

from .services.stt_service import STTService
from .services.tts_service import TTSService
from .config import settings

app = FastAPI(
    title="Speech Services API",
    description="Unified API for Speech-to-Text and Text-to-Speech services",
    version="1.0.0"
)

# Initialize services
stt_service = STTService()
tts_service = TTSService()


class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = "default"
    language: Optional[str] = "en"
    format: Optional[str] = "wav"


class HealthResponse(BaseModel):
    status: str
    services: Dict[str, Any]


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    return HealthResponse(
        status="healthy",
        services={
            "stt": {
                "engine": settings.STT_ENGINE,
                "available": stt_service.is_available()
            },
            "tts": {
                "engine": settings.TTS_ENGINE,
                "available": tts_service.is_available()
            }
        }
    )


@app.post("/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None)
):
    """Convert speech to text"""
    if not file.content_type or not file.content_type.startswith('audio/'):
        raise HTTPException(status_code=400, detail="File must be an audio file")
    
    try:
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=f".{file.filename.split('.')[-1]}") as tmp_file:
            content = await file.read()
            tmp_file.write(content)
            tmp_file_path = tmp_file.name
        
        # Process with STT service
        result = await stt_service.transcribe(tmp_file_path, language)
        
        # Clean up temporary file
        os.unlink(tmp_file_path)
        
        return {"text": result, "engine": settings.STT_ENGINE}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STT processing failed: {str(e)}")


@app.post("/tts")
async def text_to_speech(request: TTSRequest):
    """Convert text to speech"""
    try:
        audio_generator = tts_service.synthesize(
            text=request.text,
            voice=request.voice,
            language=request.language,
            format=request.format
        )
        
        return StreamingResponse(
            audio_generator,
            media_type=f"audio/{request.format}",
            headers={"Content-Disposition": "attachment; filename=speech.wav"}
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS processing failed: {str(e)}")


@app.get("/engines")
async def get_available_engines():
    """Get information about available speech engines"""
    return {
        "stt_engines": stt_service.get_available_engines(),
        "tts_engines": tts_service.get_available_engines(),
        "current": {
            "stt": settings.STT_ENGINE,
            "tts": settings.TTS_ENGINE
        }
    }


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=False
    )