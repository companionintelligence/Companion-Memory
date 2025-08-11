#!/usr/bin/env python3
"""
Comprehensive test for WhisperX transcription pipeline
"""

import time
import base64
import requests
import json
import numpy as np

def create_test_audio(duration_seconds=3, sample_rate=16000, frequency=440):
    """Create a simple test audio with a sine wave tone"""
    t = np.linspace(0, duration_seconds, int(sample_rate * duration_seconds), False)
    audio = np.sin(2 * np.pi * frequency * t) * 0.3
    return audio.astype(np.float32)

def create_wav_header(audio_data, sample_rate=16000):
    """Create WAV header for audio data"""
    import struct
    
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(audio_data) * 2  # 2 bytes per sample
    
    # Convert float32 to int16
    audio_int16 = (audio_data * 32767).astype(np.int16)
    
    # Create WAV header
    wav_header = struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF',                    # Chunk ID
        36 + data_size,             # Chunk size
        b'WAVE',                    # Format
        b'fmt ',                    # Subchunk1 ID
        16,                         # Subchunk1 size
        1,                          # Audio format (PCM)
        num_channels,               # Number of channels
        sample_rate,                # Sample rate
        byte_rate,                  # Byte rate
        block_align,                # Block align
        bits_per_sample,            # Bits per sample
        b'data',                    # Subchunk2 ID
        data_size                   # Subchunk2 size
    )
    
    return wav_header + audio_int16.tobytes()

def test_transcription_pipeline():
    """Test the complete transcription pipeline"""
    
    base_url = "http://localhost:9000"
    
    print("=== WhisperX Transcription Pipeline Test ===")
    
    # Test 1: Health check
    print("\n1. Testing health check...")
    try:
        response = requests.get(f"{base_url}/health", timeout=10)
        if response.status_code == 200:
            health = response.json()
            print(f"✓ Health check passed: {health}")
            if not health.get('whisperx', False):
                print("⚠ Warning: WhisperX model not loaded")
                return False
        else:
            print(f"✗ Health check failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"✗ Health check error: {e}")
        return False
    
    # Test 2: Create test audio
    print("\n2. Creating test audio...")
    try:
        # Create 3 seconds of audio with a tone
        audio_data = create_test_audio(duration_seconds=3, frequency=440)
        wav_data = create_wav_header(audio_data)
        audio_base64 = base64.b64encode(wav_data).decode('utf-8')
        print(f"✓ Created test audio: {len(wav_data)} bytes")
    except Exception as e:
        print(f"✗ Failed to create test audio: {e}")
        return False
    
    # Test 3: Transcription
    print("\n3. Testing transcription...")
    try:
        start_time = time.time()
        
        response = requests.post(
            f"{base_url}/transcribe",
            json={
                "audio_data": audio_base64,
                "sample_rate": 16000,
                "language": "en",
                "model_size": "base",
                "enable_diarization": False,
            },
            timeout=60
        )
        
        processing_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            print(f"✓ Transcription completed in {processing_time:.3f}s")
            print(f"  Response: {result}")
            
            # Check response structure
            required_fields = ['text', 'segments', 'language', 'confidence']
            missing_fields = [field for field in required_fields if field not in result]
            
            if missing_fields:
                print(f"✗ Missing required fields: {missing_fields}")
                return False
            
            print(f"✓ Response structure is correct")
            print(f"  Text: '{result.get('text', '')}'")
            print(f"  Language: {result.get('language', 'unknown')}")
            print(f"  Confidence: {result.get('confidence', 0.0):.3f}")
            print(f"  Segments: {len(result.get('segments', []))}")
            
            # Note: Tone audio won't have speech, so empty text is expected
            if not result.get('text', '').strip():
                print("  Note: Empty transcription expected for tone audio")
            
            return True
            
        else:
            print(f"✗ Transcription failed: {response.status_code}")
            print(f"  Error: {response.text}")
            return False
            
    except Exception as e:
        print(f"✗ Transcription error: {e}")
        return False

def test_silence_audio():
    """Test with silence audio"""
    
    base_url = "http://localhost:9000"
    
    print("\n4. Testing silence audio...")
    try:
        # Create 2 seconds of silence
        audio_data = np.zeros(16000 * 2, dtype=np.float32)  # 2 seconds of silence
        wav_data = create_wav_header(audio_data)
        audio_base64 = base64.b64encode(wav_data).decode('utf-8')
        
        start_time = time.time()
        
        response = requests.post(
            f"{base_url}/transcribe",
            json={
                "audio_data": audio_base64,
                "sample_rate": 16000,
                "language": "en",
                "model_size": "base",
                "enable_diarization": False,
            },
            timeout=30
        )
        
        processing_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            print(f"✓ Silence test completed in {processing_time:.3f}s")
            print(f"  Text: '{result.get('text', '')}'")
            print(f"  Expected: Empty or very short text for silence")
            return True
        else:
            print(f"✗ Silence test failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"✗ Silence test error: {e}")
        return False

if __name__ == "__main__":
    print("Starting comprehensive transcription test...")
    
    # Run main test
    success = test_transcription_pipeline()
    
    if success:
        # Run silence test
        test_silence_audio()
        print("\n=== Test Summary ===")
        print("✓ Transcription pipeline is working correctly")
        print("✓ WhisperX model is loaded and responding")
        print("✓ Audio processing and conversion is functional")
    else:
        print("\n=== Test Summary ===")
        print("✗ Transcription pipeline has issues")
        print("  - Check if voice service is running")
        print("  - Check if WhisperX model is loaded")
        print("  - Check logs for errors")
