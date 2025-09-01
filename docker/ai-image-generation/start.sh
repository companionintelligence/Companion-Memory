#!/bin/sh

# Startup script for Multi-Model AI Image Generation Service

echo "🚀 Starting Multi-Model AI Image Generation Service..."
echo "🤖 Supported models: FLUX.1-schnell, FLUX.1-dev, SDXL, SD 1.5"

# Check if PyTorch is available
python -c "import torch; print(f'✅ PyTorch {torch.__version__} available')" 2>/dev/null
if [ $? -eq 0 ]; then
    # PyTorch is available, check for GPU
    USE_GPU=false
    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "🔥 NVIDIA GPU detected"
        nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo "GPU query failed"
        
        # Check if we have at least 8GB of GPU memory for AI models
        GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
        if [ -n "$GPU_MEM" ] && [ "$GPU_MEM" -gt 8000 ]; then
            USE_GPU=true
            echo "✅ Sufficient GPU memory detected (${GPU_MEM}MB), using full AI models"
        else
            echo "⚠️  Limited or no GPU memory, falling back to CPU mode"
        fi
    else
        echo "💻 No NVIDIA GPU detected, using CPU"
    fi

    # Check if diffusers is available
    python -c "import diffusers; print('✅ Diffusers library available')" 2>/dev/null
    if [ $? -eq 0 ] && [ "$USE_GPU" = true ]; then
        echo "🐍 Starting Python application with GPU acceleration and diffusers"
        exec python app.py
    else
        echo "🐍 Starting Python application in CPU fallback mode"
        exec python app_cpu.py
    fi
else
    echo "⚠️  PyTorch not available, using basic CPU fallback mode"
    echo "🐍 Starting Python application in CPU fallback mode"
    exec python app_cpu.py
fi