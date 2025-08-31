"""
Speech-to-Text service implementations
"""
import os
import asyncio
from typing import Optional, List, Dict, Any
from abc import ABC, abstractmethod

try:
    import whisper
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False

from ..config import settings


class BaseSTTService(ABC):
    """Abstract base class for STT services"""
    
    @abstractmethod
    async def transcribe(self, audio_path: str, language: Optional[str] = None) -> str:
        pass
    
    @abstractmethod
    def is_available(self) -> bool:
        pass
    
    @abstractmethod
    def get_engine_name(self) -> str:
        pass


class WhisperSTTService(BaseSTTService):
    """Whisper STT implementation"""
    
    def __init__(self):
        self.model = None
        if WHISPER_AVAILABLE:
            try:
                self.model = whisper.load_model(settings.WHISPER_MODEL, device=settings.WHISPER_DEVICE)
            except Exception as e:
                print(f"Failed to load Whisper model: {e}")
    
    async def transcribe(self, audio_path: str, language: Optional[str] = None) -> str:
        if not self.model:
            raise RuntimeError("Whisper model not available")
        
        # Run transcription in thread pool to avoid blocking
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, 
            lambda: self.model.transcribe(audio_path, language=language)
        )
        
        return result["text"].strip()
    
    def is_available(self) -> bool:
        return WHISPER_AVAILABLE and self.model is not None
    
    def get_engine_name(self) -> str:
        return "whisper"


class MockSTTService(BaseSTTService):
    """Mock STT service for testing when no engines are available"""
    
    async def transcribe(self, audio_path: str, language: Optional[str] = None) -> str:
        return "Mock transcription: Hello, this is a test transcription."
    
    def is_available(self) -> bool:
        return True
    
    def get_engine_name(self) -> str:
        return "mock"


class STTService:
    """STT service manager"""
    
    def __init__(self):
        self.services = {
            "whisper": WhisperSTTService(),
            "mock": MockSTTService()
        }
        
        # Select the requested engine or fall back to mock
        engine_name = settings.STT_ENGINE
        if engine_name in self.services and self.services[engine_name].is_available():
            self.current_service = self.services[engine_name]
        else:
            print(f"STT engine '{engine_name}' not available, falling back to mock")
            self.current_service = self.services["mock"]
    
    async def transcribe(self, audio_path: str, language: Optional[str] = None) -> str:
        return await self.current_service.transcribe(audio_path, language)
    
    def is_available(self) -> bool:
        return self.current_service.is_available()
    
    def get_available_engines(self) -> List[str]:
        return [name for name, service in self.services.items() if service.is_available()]
    
    def get_current_engine(self) -> str:
        return self.current_service.get_engine_name()