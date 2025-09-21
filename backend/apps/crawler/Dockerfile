FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    tini \
    build-essential \
    gcc \
    g++ \
    python3-dev \
    libffi-dev \
    libssl-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install playwright browsers and dependencies
RUN playwright install --with-deps chromium

# Run crawl4ai setup
RUN crawl4ai-setup

# Copy application code
COPY crawler_service.py .

# Create necessary directories
RUN mkdir -p /app/data /app/cache

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV CRAWL4AI_CACHE_DIR=/app/cache
ENV CRAWL4AI_DATA_DIR=/app/data

# Expose port
EXPOSE 9003

# Use tini as init system
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "crawler_service.py"]
