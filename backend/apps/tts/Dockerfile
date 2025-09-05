FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    wget \
    build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy all requirements files
COPY requirements.base.txt .
COPY requirements.piper.txt .

# Copy application code
COPY tts_service.py .

# Create a script to install dependencies based on VOICE_MODEL
RUN echo '#!/bin/bash\n\
if [ "$VOICE_MODEL" = "vllm-higgs" ]; then\n\
    echo "Installing Higgs vLLM dependencies..."\n\
    pip install --no-cache-dir -r requirements.higgs-vllm.txt\n\
elif [ "$VOICE_MODEL" = "higgs" ]; then\n\
    echo "Installing Higgs Audio dependencies..."\n\
    pip install --no-cache-dir -r requirements.higgs.txt\n\
elif [ "$VOICE_MODEL" = "piper" ]; then\n\
    echo "Installing Piper TTS dependencies..."\n\
    pip install --no-cache-dir -r requirements.piper.txt\n\
    # Create models directory for Piper\n\
    mkdir -p /app/models/piper\n\
    cd /app/models/piper\n\
    wget -O en_US-amy-low.onnx https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/low/en_US-amy-low.onnx\n\
    wget -O en_US-amy-low.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/low/en_US-amy-low.onnx.json\n\
    cd /app\n\
else\n\
    echo "Unknown VOICE_MODEL: $VOICE_MODEL. Supported values: piper, higgs, vllm-higgs"\n\
    exit 1\n\
fi\n\
exec python tts_service.py' > /app/start.sh && chmod +x /app/start.sh

# Expose port
EXPOSE 9002

# Run the startup script
CMD ["/app/start.sh"]
