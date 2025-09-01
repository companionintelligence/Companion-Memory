FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt ./

# Install base dependencies (without SSL verification due to environment constraints)
RUN pip install --no-cache-dir --upgrade pip --trusted-host pypi.org --trusted-host pypi.python.org --trusted-host files.pythonhosted.org && \
    pip install --no-cache-dir -r requirements.txt --trusted-host pypi.org --trusted-host pypi.python.org --trusted-host files.pythonhosted.org

# Try to install AI dependencies but don't fail if they can't be installed
RUN pip install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu --trusted-host download.pytorch.org --trusted-host files.pythonhosted.org || echo "PyTorch installation failed, will use CPU fallback" && \
    pip install --no-cache-dir transformers accelerate diffusers --trusted-host pypi.org --trusted-host pypi.python.org --trusted-host files.pythonhosted.org || echo "Diffusers installation failed, will use CPU fallback"

# Copy application code
COPY . .

# Make startup script executable
RUN chmod +x start.sh

# Create directories with proper permissions
RUN mkdir -p /app/models /app/outputs && \
    chmod 755 /app/models /app/outputs

# Expose port
EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:7860/health || exit 1

# Start the service
CMD ["./start.sh"]