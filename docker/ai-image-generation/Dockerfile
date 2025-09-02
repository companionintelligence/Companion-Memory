FROM python:3.11-slim

WORKDIR /app

# Build arguments for model configuration
ARG INCLUDE_FLUX_SCHNELL=true
ARG INCLUDE_FLUX_DEV=false
ARG INCLUDE_SDXL=true
ARG INCLUDE_SD15=false
ARG CUSTOM_FLUX_SCHNELL_MODEL=""
ARG CUSTOM_FLUX_DEV_MODEL=""
ARG CUSTOM_SDXL_MODEL=""
ARG CUSTOM_SD15_MODEL=""

# Environment variables that can be overridden at runtime
ENV INCLUDE_FLUX_SCHNELL=${INCLUDE_FLUX_SCHNELL}
ENV INCLUDE_FLUX_DEV=${INCLUDE_FLUX_DEV}
ENV INCLUDE_SDXL=${INCLUDE_SDXL}
ENV INCLUDE_SD15=${INCLUDE_SD15}
ENV CUSTOM_FLUX_SCHNELL_MODEL=${CUSTOM_FLUX_SCHNELL_MODEL}
ENV CUSTOM_FLUX_DEV_MODEL=${CUSTOM_FLUX_DEV_MODEL}
ENV CUSTOM_SDXL_MODEL=${CUSTOM_SDXL_MODEL}
ENV CUSTOM_SD15_MODEL=${CUSTOM_SD15_MODEL}

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    git \
    git-lfs \
    build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install

# Copy requirements first for better caching
COPY requirements.txt ./

# Install base dependencies (without SSL verification due to environment constraints)
RUN pip install --no-cache-dir --upgrade pip --trusted-host pypi.org --trusted-host pypi.python.org --trusted-host files.pythonhosted.org && \
    pip install --no-cache-dir -r requirements.txt --trusted-host pypi.org --trusted-host pypi.python.org --trusted-host files.pythonhosted.org

# Install PyTorch for multiple compute platforms (CPU by default, can be overridden at runtime)
# Install CPU version first as the base
RUN pip install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu --trusted-host download.pytorch.org --trusted-host files.pythonhosted.org || echo "PyTorch CPU installation failed"

# Try to install CUDA version (will be used if NVIDIA GPU detected at runtime)
RUN pip install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 --trusted-host download.pytorch.org --trusted-host files.pythonhosted.org || echo "PyTorch CUDA installation failed, using CPU fallback"

# Try to install ROCm version (will be used if AMD GPU detected at runtime)
RUN pip install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm6.0 --trusted-host download.pytorch.org --trusted-host files.pythonhosted.org || echo "PyTorch ROCm installation failed, using CPU fallback"

# Install AI dependencies
RUN pip install --no-cache-dir transformers accelerate diffusers --trusted-host pypi.org --trusted-host pypi.python.org --trusted-host files.pythonhosted.org || echo "Diffusers installation failed, will use CPU fallback"

# Create directories with proper permissions
RUN mkdir -p /app/models /app/outputs && \
    chmod 755 /app/models /app/outputs

# Pre-download models based on configuration
# Create a model downloader script
COPY download_models.py ./
RUN python download_models.py

# Copy application code
COPY . .

# Make startup script executable
RUN chmod +x start.sh

# Expose port
EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:7860/health || exit 1

# Start the service
CMD ["./start.sh"]