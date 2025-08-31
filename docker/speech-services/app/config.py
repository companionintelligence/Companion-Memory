"""
Configuration settings for speech services
"""
import os
from typing import Optional


class Settings:
    # Service configuration
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))
    
    # Engine selection
    STT_ENGINE: str = os.getenv("STT_ENGINE", "whisper")
    TTS_ENGINE: str = os.getenv("TTS_ENGINE", "piper")
    
    # Whisper STT configuration
    WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "base")
    WHISPER_DEVICE: str = os.getenv("WHISPER_DEVICE", "cpu")
    
    # Piper TTS configuration
    PIPER_MODEL_PATH: str = os.getenv("PIPER_MODEL_PATH", "/app/models/piper")
    PIPER_VOICE: str = os.getenv("PIPER_VOICE", "en_US-ljspeech-medium")
    
    # Model cache directory
    MODEL_CACHE_DIR: str = os.getenv("MODEL_CACHE_DIR", "/app/models")
    
    # HuggingFace configuration (for future use)
    HF_TOKEN: Optional[str] = os.getenv("HF_TOKEN")
    
    # VibeVoice configuration (placeholder for future implementation)
    VIBE_VOICE_ENDPOINT: Optional[str] = os.getenv("VIBE_VOICE_ENDPOINT")
    
    # Higgs Boson configuration (placeholder for future implementation) 
    HIGGS_API_KEY: Optional[str] = os.getenv("HIGGS_API_KEY")
    HIGGS_ENDPOINT: Optional[str] = os.getenv("HIGGS_ENDPOINT")


settings = Settings()