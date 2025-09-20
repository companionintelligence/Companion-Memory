FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libgomp1 \
    tini \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY stt_service.py .

# Create models directory
RUN mkdir -p /app/models

# Expose port
EXPOSE 9001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["gunicorn", "stt_service:app", "-w", "1", "-k", "uvicorn.workers.UvicornWorker", "--bind", "0.0.0.0:9001", "--max-requests", "1000", "--max-requests-jitter", "100", "--timeout", "300", "--keep-alive", "30", "--limit-request-line", "8190", "--limit-request-fields", "100", "--worker-connections", "1000", "--max-requests-jitter", "100"]