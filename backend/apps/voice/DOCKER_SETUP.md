# Docker Setup with Belinda Voice TTS

## 🎯 **Overview**
This guide explains how to set up the voice service with Higgs Audio and Belinda voice in Docker, ensuring seamless startup without manual setup scripts.

## 🐳 **Docker Configuration**

### **Updated Dockerfile Features:**
- ✅ **Automatic Higgs Audio installation** from git repository
- ✅ **Belinda voice support** as default TTS voice
- ✅ **All dependencies included** in container build
- ✅ **No manual setup required** - everything works out of the box

### **Key Changes Made:**

1. **Higgs Audio Installation:**
   ```dockerfile
   # Clone and install Higgs Audio
   RUN git clone https://github.com/boson-ai/higgs-audio.git /opt/higgs-audio
   WORKDIR /opt/higgs-audio
   RUN pip install -r requirements.txt
   RUN pip install -e .
   ```

2. **Belinda Voice Integration:**
   - Default voice changed from "alloy" to "belinda"
   - Voice-specific parameters added to TTS generation
   - Consistent seed (12345) for voice quality

3. **Robust Model Loading:**
   - Multiple model path fallbacks
   - Better error handling and logging
   - Automatic device detection (CUDA/CPU)

## 🚀 **Quick Start**

### **1. Build the Docker Image:**
```bash
cd backend/apps/voice
docker build -f Dockerfile.voice-service -t voice-service .
```

### **2. Run the Container:**
```bash
docker run -p 9002:9000 voice-service
```

### **3. Test the Service:**
```bash
# Health check
curl http://localhost:9002/health

# Test Belinda voice TTS
python test_belinda_voice.py
```

## 🎤 **Belinda Voice Features**

### **Voice Characteristics:**
- **Natural speech**: High-quality, human-like voice
- **Consistent quality**: Fixed seed ensures consistent output
- **Fast generation**: Optimized for real-time TTS
- **Clear pronunciation**: Excellent for conversational AI

### **Usage in Frontend:**
- Listen button automatically uses Belinda voice
- No user configuration required
- High-quality audio output

## 🔧 **Technical Implementation**

### **TTS Generation Process:**
1. **Text Input**: User text from chat interface
2. **Voice Specification**: "Generate audio in belinda voice: [text]"
3. **Model Processing**: Higgs Audio serve engine with Belinda parameters
4. **Audio Output**: High-quality WAV audio with natural voice

### **Key Parameters:**
```python
# Voice-specific generation parameters
output = serve_engine.generate(
    chat_ml_sample=ChatMLSample(messages=messages),
    max_new_tokens=1024,
    temperature=0.3,
    top_p=0.95,
    top_k=50,
    stop_strings=["<|end_of_text|>", "<|eot_id|>"],
    ref_audio="belinda",  # Belinda voice reference
    seed=12345,  # Consistent seed for quality
)
```

## 📊 **Performance Expectations**

### **First Run (Model Loading):**
- **Loading time**: 30-60 seconds
- **Model download**: Automatic from HuggingFace
- **Memory usage**: ~4GB VRAM/RAM

### **Subsequent Runs (Cached Model):**
- **TTS generation**: 2-15 seconds
- **Audio quality**: High-quality WAV output
- **Response time**: Fast and responsive

## 🧪 **Testing**

### **Test Scripts Available:**
1. **`test_belinda_voice.py`**: Comprehensive Belinda voice testing
2. **Health check**: Verify service status
3. **Performance testing**: Measure generation speed

### **Expected Test Results:**
```
✓ Health check passed
  Status: healthy
  WhisperX: true
  SesameAI: true
  Higgs Audio Loaded: true

✓ Pre-load completed in 45.2s
  Status: loaded
  Message: Higgs Audio model loaded successfully

✓ Belinda voice TTS completed in 8.3s
  Audio data length: 12345 chars
  Duration: 3.2s
  Sample rate: 22050 Hz
  ✓ Audio is valid WAV format
  ✓ TTS is FAST (< 15s)
```

## 🔍 **Troubleshooting**

### **Common Issues:**

1. **Model Loading Fails:**
   ```bash
   # Check container logs
   docker logs <container_id>
   
   # Verify internet connection for model download
   docker exec <container_id> ping huggingface.co
   ```

2. **Memory Issues:**
   ```bash
   # Check available memory
   docker stats <container_id>
   
   # Increase memory limit if needed
   docker run -p 9002:9000 --memory=8g voice-service
   ```

3. **Port Conflicts:**
   ```bash
   # Check if port is in use
   lsof -i :9002
   
   # Use different port
   docker run -p 9003:9000 voice-service
   ```

### **Debug Commands:**
```bash
# Enter container for debugging
docker exec -it <container_id> /bin/bash

# Check Higgs Audio installation
python -c "from boson_multimodal.serve.serve_engine import HiggsAudioServeEngine; print('✓ Higgs Audio available')"

# Test model loading
python -c "from boson_multimodal.serve.serve_engine import HiggsAudioServeEngine; engine = HiggsAudioServeEngine('bosonai/higgs-audio-v2-generation-3B-base', 'bosonai/higgs-audio-v2-tokenizer', device='cpu'); print('✓ Model loaded')"
```

## 🎉 **Success Indicators**

### **When Everything Works:**
- ✅ Health check shows `"sesameai": true`
- ✅ Pre-load endpoint returns `"status": "loaded"`
- ✅ TTS generates audio in 2-15 seconds
- ✅ Listen button shows "Live" instead of "Offline"
- ✅ Audio quality is high and natural

### **Frontend Integration:**
- Voice recording works (WhisperX)
- Text-to-speech works (Belinda voice)
- Real-time audio level visualization
- Seamless user experience

## 📝 **Summary**

The Docker setup now provides:
- **Seamless installation**: No manual setup required
- **Belinda voice**: High-quality, natural TTS
- **Fast performance**: Optimized for real-time use
- **Robust error handling**: Better reliability
- **Easy deployment**: One command to start everything

The voice service is now production-ready with Belinda voice TTS! 🎤✨
