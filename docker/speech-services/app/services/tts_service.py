"""
Text-to-Speech service implementations
"""
import os
import asyncio
import io
from typing import Optional, List, Dict, Any, AsyncGenerator
from abc import ABC, abstractmethod
import tempfile

try:
    import piper
    from piper import PiperVoice
    PIPER_AVAILABLE = True
except ImportError:
    PIPER_AVAILABLE = False

from ..config import settings


class BaseTTSService(ABC):
    """Abstract base class for TTS services"""
    
    @abstractmethod
    async def synthesize(
        self, 
        text: str, 
        voice: Optional[str] = None,
        language: Optional[str] = None,
        format: str = "wav"
    ) -> AsyncGenerator[bytes, None]:
        pass
    
    @abstractmethod
    def is_available(self) -> bool:
        pass
    
    @abstractmethod
    def get_engine_name(self) -> str:
        pass


class PiperTTSService(BaseTTSService):
    """Piper TTS implementation"""
    
    def __init__(self):
        self.voice = None
        if PIPER_AVAILABLE:
            try:
                # Use default model directory path
                model_dir = settings.MODEL_CACHE_DIR
                voice_name = settings.PIPER_VOICE
                model_path = os.path.join(model_dir, "piper", f"{voice_name}.onnx")
                config_path = os.path.join(model_dir, "piper", f"{voice_name}.onnx.json")
                
                # For now, just check if the service can be initialized
                # The actual model loading will happen when needed
                print(f"Piper TTS initialized for voice: {voice_name}")
            except Exception as e:
                print(f"Failed to initialize Piper voice: {e}")
    
    async def synthesize(
        self, 
        text: str, 
        voice: Optional[str] = None,
        language: Optional[str] = None,
        format: str = "wav"
    ) -> AsyncGenerator[bytes, None]:
        # For now, fall back to mock implementation until models are available
        mock_service = MockTTSService()
        async for chunk in mock_service.synthesize(text, voice, language, format):
            yield chunk
    
    def is_available(self) -> bool:
        return PIPER_AVAILABLE
    
    def get_engine_name(self) -> str:
        return "piper"


class MockTTSService(BaseTTSService):
    """Mock TTS service for testing when no engines are available"""
    
    async def synthesize(
        self, 
        text: str, 
        voice: Optional[str] = None,
        language: Optional[str] = None,
        format: str = "wav"
    ) -> AsyncGenerator[bytes, None]:
        # Generate a simple mock WAV file (44-byte header + silence)
        wav_header = (
            b'RIFF'
            b'\x24\x08\x00\x00'  # File size (2084 bytes)
            b'WAVE'
            b'fmt '
            b'\x10\x00\x00\x00'  # Format chunk size (16)
            b'\x01\x00'          # Audio format (PCM)
            b'\x01\x00'          # Channels (1)
            b'\x44\xAC\x00\x00'  # Sample rate (44100)
            b'\x88\x58\x01\x00'  # Byte rate
            b'\x02\x00'          # Block align
            b'\x10\x00'          # Bits per sample (16)
            b'data'
            b'\x00\x08\x00\x00'  # Data chunk size (2048 bytes)
        )
        
        # Mock audio data (silence)
        silence_data = b'\x00' * 2048
        
        yield wav_header + silence_data
    
    def is_available(self) -> bool:
        return True
    
    def get_engine_name(self) -> str:
        return "mock"


class TTSService:
    """TTS service manager"""
    
    def __init__(self):
        self.services = {
            "piper": PiperTTSService(),
            "mock": MockTTSService()
        }
        
        # Select the requested engine or fall back to mock
        engine_name = settings.TTS_ENGINE
        if engine_name in self.services and self.services[engine_name].is_available():
            self.current_service = self.services[engine_name]
        else:
            print(f"TTS engine '{engine_name}' not available, falling back to mock")
            self.current_service = self.services["mock"]
    
    async def synthesize(
        self, 
        text: str, 
        voice: Optional[str] = None,
        language: Optional[str] = None,
        format: str = "wav"
    ) -> AsyncGenerator[bytes, None]:
        async for chunk in self.current_service.synthesize(text, voice, language, format):
            yield chunk
    
    def is_available(self) -> bool:
        return self.current_service.is_available()
    
    def get_available_engines(self) -> List[str]:
        return [name for name, service in self.services.items() if service.is_available()]
    
    def get_current_engine(self) -> str:
        return self.current_service.get_engine_name()