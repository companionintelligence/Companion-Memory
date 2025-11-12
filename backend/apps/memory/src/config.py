"""
Configuration management for CI-Memory Summarization Agent.
"""
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Database Configuration
    database_url: str
    
    # LLM Configuration
    llm_api_base: str = "http://localhost:11434/v1"
    llm_api_key: str = "ollama"
    llm_model: str = "qwen2.5:32b"
    llm_temperature: float = 0.3
    llm_max_tokens: int = 2000
    
    # Embedding Configuration
    embedding_model: str = "nomic-embed-text"
    embedding_dimensions: int = 768
    
    # Agent Configuration
    agent_name: str = "memory-summarization-agent"
    agent_version: str = "1.0.0"
    agent_check_interval_seconds: int = 30
    summary_queue_name: str = "memory-summaries"
    queue_fetch_batch_size: int = 5
    queue_empty_backoff_seconds: int = 5
    queue_error_backoff_seconds: int = 5
    
    # Summarization Configuration
    summary_overlap_minutes: int = 5
    max_items_per_category: int = 100
    
    # Logging
    log_level: str = "INFO"
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )


# Global settings instance
settings = Settings()
