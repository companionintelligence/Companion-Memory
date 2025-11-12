"""
Tests for configuration management.
"""
import pytest
from src.config import Settings


def test_settings_defaults():
    """Test default settings values."""
    settings = Settings(database_url="postgresql://test")
    
    assert settings.llm_model == "qwen2.5:32b"
    assert settings.agent_name == "memory-summarization-agent"
    assert settings.agent_version == "1.0.0"
    assert settings.embedding_dimensions == 768
    assert settings.summary_overlap_minutes == 5


def test_settings_from_env(monkeypatch):
    """Test settings loaded from environment."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://custom")
    monkeypatch.setenv("LLM_MODEL", "llama3.1:70b")
    monkeypatch.setenv("AGENT_CHECK_INTERVAL_SECONDS", "60")
    
    settings = Settings()
    
    assert settings.database_url == "postgresql://custom"
    assert settings.llm_model == "llama3.1:70b"
    assert settings.agent_check_interval_seconds == 60
