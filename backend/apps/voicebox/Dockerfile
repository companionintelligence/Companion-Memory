FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY voicebox_service.py .

# Create directories for models and voice profiles
RUN mkdir -p /app/models/voices /app/models/base

# Expose port
EXPOSE 9003

# Run the service
CMD ["python", "voicebox_service.py"]
