"""
Configuration for WhisperX Voice Service
"""

import os
from typing import Optional
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

class Config:
    """Configuration class for WhisperX Voice Service"""
    
    # Server settings
    HOST: str = os.getenv("VOICE_HOST", "0.0.0.0")
    PORT: int = int(os.getenv("VOICE_PORT", "9000"))
    DEBUG: bool = os.getenv("VOICE_DEBUG", "false").lower() == "true"
    
    # WhisperX settings
    WHISPER_MODEL_SIZE: str = os.getenv("WHISPER_MODEL_SIZE", "base")
    WHISPER_DEVICE: str = os.getenv("WHISPER_DEVICE", "cpu")  # cpu or cuda
    WHISPER_COMPUTE_TYPE: str = os.getenv("WHISPER_COMPUTE_TYPE", "int8")  # int8, float16, float32
    WHISPER_BATCH_SIZE: int = int(os.getenv("WHISPER_BATCH_SIZE", "16"))
    WHISPER_LANGUAGE: str = os.getenv("WHISPER_LANGUAGE", "en")
    
    # Audio settings
    SAMPLE_RATE: int = int(os.getenv("SAMPLE_RATE", "16000"))
    CHANNELS: int = int(os.getenv("CHANNELS", "1"))
    
    # Session settings
    MAX_SESSION_DURATION: int = int(os.getenv("MAX_SESSION_DURATION", "300"))  # 5 minutes
    MAX_AUDIO_CHUNK_SIZE: int = int(os.getenv("MAX_AUDIO_CHUNK_SIZE", "1048576"))  # 1MB
    
    # Logging
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_FILE: str = os.getenv("LOG_FILE", "logs/voice_service.log")
    
    # CORS settings
    CORS_ORIGINS: list = os.getenv("CORS_ORIGINS", "*").split(",")
    
    # API settings
    API_PREFIX: str = os.getenv("API_PREFIX", "")
    API_TITLE: str = "WhisperX Voice Service"
    API_VERSION: str = "1.0.0"
    
    @classmethod
    def get_whisper_config(cls) -> dict:
        """Get WhisperX configuration"""
        return {
            "model_size": cls.WHISPER_MODEL_SIZE,
            "device": cls.WHISPER_DEVICE,
            "compute_type": cls.WHISPER_COMPUTE_TYPE,
            "batch_size": cls.WHISPER_BATCH_SIZE,
            "language": cls.WHISPER_LANGUAGE
        }
    
    @classmethod
    def get_audio_config(cls) -> dict:
        """Get audio configuration"""
        return {
            "sample_rate": cls.SAMPLE_RATE,
            "channels": cls.CHANNELS
        }
    
    @classmethod
    def validate(cls) -> bool:
        """Validate configuration"""
        valid_model_sizes = ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"]
        valid_devices = ["cpu", "cuda"]
        valid_compute_types = ["int8", "float16", "float32"]
        
        if cls.WHISPER_MODEL_SIZE not in valid_model_sizes:
            print(f"Invalid WHISPER_MODEL_SIZE: {cls.WHISPER_MODEL_SIZE}")
            return False
        
        if cls.WHISPER_DEVICE not in valid_devices:
            print(f"Invalid WHISPER_DEVICE: {cls.WHISPER_DEVICE}")
            return False
        
        if cls.WHISPER_COMPUTE_TYPE not in valid_compute_types:
            print(f"Invalid WHISPER_COMPUTE_TYPE: {cls.WHISPER_COMPUTE_TYPE}")
            return False
        
        return True

# Global config instance
config = Config() 