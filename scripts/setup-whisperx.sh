#!/bin/bash

# Setup script for WhisperX voice processing service
# This script sets up the Python environment and downloads WhisperX models

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
VOICE_ENV_DIR="$BACKEND_DIR/voice_env"

echo "🔊 Setting up WhisperX voice processing service..."

# Check if Python 3 is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3.8 or higher."
    exit 1
fi

# Check Python version
PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
REQUIRED_VERSION="3.8"

if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$PYTHON_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
    echo "❌ Python version $PYTHON_VERSION is too old. Please install Python 3.8 or higher."
    exit 1
fi

echo "✅ Python $PYTHON_VERSION found"

# Create virtual environment if it doesn't exist
if [ ! -d "$VOICE_ENV_DIR" ]; then
    echo "📦 Creating Python virtual environment..."
    cd "$BACKEND_DIR"
    python3 -m venv voice_env
    echo "✅ Virtual environment created"
else
    echo "✅ Virtual environment already exists"
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source "$VOICE_ENV_DIR/bin/activate"

# Upgrade pip
echo "⬆️ Upgrading pip..."
pip install --upgrade pip

# Install requirements
echo "📦 Installing Python dependencies..."
cd "$BACKEND_DIR"
pip install -r requirements.txt

# Create models directory
MODELS_DIR="$BACKEND_DIR/models"
mkdir -p "$MODELS_DIR"

echo "📥 Downloading WhisperX models..."
echo "⚠️ This may take a while depending on your internet connection and model size."

# Download WhisperX base model (this will be cached by WhisperX)
echo "🔍 Testing WhisperX installation..."
python3 -c "
import whisperx
import torch

print('Testing WhisperX installation...')
device = 'cuda' if torch.cuda.is_available() else 'cpu'
compute_type = 'float16' if device == 'cuda' else 'int8'

print(f'Using device: {device}')
print(f'Compute type: {compute_type}')

# This will download the model on first run
model = whisperx.load_model('base', device, compute_type=compute_type, language='en')
print('✅ WhisperX base model loaded successfully')

# Test alignment model download
model_a, metadata = whisperx.load_align_model(language_code='en', device=device)
print('✅ WhisperX alignment model loaded successfully')
"

echo ""
echo "✅ WhisperX setup completed successfully!"
echo ""
echo "📋 Next steps:"
echo "1. Start the WhisperX service: cd backend && source voice_env/bin/activate && python voice_service.py"
echo "2. Or use the make command: make voice-service"
echo ""
echo "📁 Model files are stored in:"
echo "   - ~/.cache/whisperx/ (WhisperX models)"
echo "   - ~/.cache/torch/ (PyTorch models)"
echo "   - ~/.cache/huggingface/ (HuggingFace models)"
echo ""
echo "⚠️ These directories are excluded from git to avoid committing large model files." 