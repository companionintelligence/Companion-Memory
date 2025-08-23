FROM python:3.11

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    wget \
    build-essential \
    libgomp1 \
    libc6-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set environment variable to avoid the library issue
ENV LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH

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

# Run the application
CMD ["python", "stt_service.py"]
