#!/bin/sh

# Startup script for Multi-Model AI Image Generation Service

echo "🚀 Starting Multi-Model AI Image Generation Service..."
echo "🤖 Supported models: FLUX.1-schnell, FLUX.1-dev, SDXL, SD 1.5"

# Check if PyTorch is available
python -c "import torch; print(f'✅ PyTorch {torch.__version__} available')" 2>/dev/null
if [ $? -eq 0 ]; then
    # PyTorch is available, check for GPU
    USE_GPU=false
    GPU_TYPE="none"
    
    # Check for NVIDIA GPU first
    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "🔥 NVIDIA GPU detected"
        nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo "GPU query failed"
        
        # Check if we have at least 8GB of GPU memory for AI models
        GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
        if [ -n "$GPU_MEM" ] && [ "$GPU_MEM" -gt 8000 ]; then
            USE_GPU=true
            GPU_TYPE="cuda"
            echo "✅ Sufficient NVIDIA GPU memory detected (${GPU_MEM}MB), using CUDA"
        else
            echo "⚠️  Limited or no NVIDIA GPU memory, checking for AMD GPU"
        fi
    fi
    
    # Check for AMD GPU if NVIDIA not suitable
    if [ "$USE_GPU" = false ] && [ -d "/dev/dri" ]; then
        echo "🔥 AMD GPU devices detected"
        if command -v rocm-smi >/dev/null 2>&1; then
            echo "✅ ROCm tools available"
            rocm-smi --showmeminfo vram 2>/dev/null || echo "AMD GPU memory query failed"
            USE_GPU=true
            GPU_TYPE="rocm"
            echo "✅ Using AMD GPU with ROCm"
        elif [ -n "$ROCM_VISIBLE_DEVICES" ] || [ "$TORCH_DEVICE" = "rocm" ]; then
            echo "✅ ROCm environment detected, attempting to use AMD GPU"
            USE_GPU=true
            GPU_TYPE="rocm"
        else
            echo "⚠️  AMD GPU detected but ROCm not configured properly"
        fi
    fi
    
    # Fallback to CPU if no GPU found
    if [ "$USE_GPU" = false ]; then
        echo "💻 No suitable GPU detected, using CPU"
        GPU_TYPE="cpu"
    fi

    # Set environment variables based on detected hardware
    if [ "$GPU_TYPE" = "cuda" ]; then
        export TORCH_DEVICE=cuda
    elif [ "$GPU_TYPE" = "rocm" ]; then
        export TORCH_DEVICE=cuda  # ROCm uses CUDA API compatibility
        export CUDA_VISIBLE_DEVICES=${ROCM_VISIBLE_DEVICES:-"all"}
    else
        export TORCH_DEVICE=cpu
    fi

    # Check if diffusers is available
    python -c "import diffusers; print('✅ Diffusers library available')" 2>/dev/null
    if [ $? -eq 0 ] && [ "$USE_GPU" = true ]; then
        echo "🐍 Starting Python application with $GPU_TYPE acceleration and diffusers"
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