# Companion

Companion is a fully self-hosted AI server that runs on your own hardware. It provides:

- **API Server** — NestJS backend with JWT authentication, PostgreSQL storage, and LLM tool integration
- **Speech-to-Text** — Local Whisper-based transcription service
- **Text-to-Speech** — Local speech synthesis
- **LLM Summarization** — AI-powered content summarization via Ollama
- **Orchestration** — Temporal-based workflow engine for background tasks
- **Object Storage** — MinIO-backed S3-compatible file storage
- **Reverse Proxy** — NGINX gateway consolidating all services behind a single port

All data stays on your device. No cloud dependencies for core functionality.
