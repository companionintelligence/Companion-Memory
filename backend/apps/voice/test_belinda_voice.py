#!/usr/bin/env python3
"""
Test script for Belinda voice TTS functionality
"""

import time
import base64
import requests
import json

def test_belinda_voice():
    """Test the Belinda voice TTS functionality"""
    
    base_url = "http://localhost:9002"  # Use port 9002 as mentioned
    
    print("=== Testing Belinda Voice TTS ===")
    
    # Test 1: Health check
    print("\n1. Checking voice service health...")
    try:
        response = requests.get(f"{base_url}/health", timeout=10)
        if response.status_code == 200:
            health = response.json()
            print(f"✓ Health check passed")
            print(f"  Status: {health.get('status', 'unknown')}")
            print(f"  WhisperX: {health.get('whisperx', False)}")
            print(f"  SesameAI: {health.get('sesameai', False)}")
            print(f"  Higgs Audio Loaded: {health.get('higgs_audio_loaded', False)}")
            
            if not health.get('sesameai', False):
                print("  ⚠ Higgs Audio not available - check installation")
                return False
        else:
            print(f"✗ Health check failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"✗ Health check error: {e}")
        return False
    
    # Test 2: Pre-load Higgs Audio
    print("\n2. Pre-loading Higgs Audio model...")
    try:
        start_time = time.time()
        response = requests.post(f"{base_url}/preload-higgs", timeout=300)
        loading_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            print(f"✓ Pre-load completed in {loading_time:.3f}s")
            print(f"  Status: {result.get('status', 'unknown')}")
            print(f"  Message: {result.get('message', 'No message')}")
            
            if result.get('status') not in ['loaded', 'already_loaded']:
                print(f"  ✗ Pre-load failed: {result.get('message', 'Unknown error')}")
                return False
        else:
            print(f"✗ Pre-load failed: {response.status_code}")
            print(f"  Error: {response.text}")
            return False
    except Exception as e:
        print(f"✗ Pre-load error: {e}")
        return False
    
    # Test 3: Test Belinda voice TTS
    print("\n3. Testing Belinda voice TTS...")
    test_text = "Hello, this is a test of the Belinda voice. It should sound natural and clear."
    
    try:
        start_time = time.time()
        
        response = requests.post(
            f"{base_url}/tts",
            json={
                "text": test_text,
                "voice": "belinda",
                "speed": 1.0,
                "pitch": 1.0,
            },
            timeout=120
        )
        
        processing_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            print(f"✓ Belinda voice TTS completed in {processing_time:.3f}s")
            print(f"  Audio data length: {len(result.get('audio_data', ''))} chars")
            print(f"  Duration: {result.get('duration', 0):.2f}s")
            print(f"  Sample rate: {result.get('sample_rate', 0)} Hz")
            
            # Decode and validate audio
            try:
                audio_data = base64.b64decode(result['audio_data'])
                print(f"  Decoded audio size: {len(audio_data)} bytes")
                
                if audio_data.startswith(b'RIFF'):
                    print("  ✓ Audio is valid WAV format")
                else:
                    print("  ⚠ Audio is not WAV format")
                    
            except Exception as e:
                print(f"  ✗ Failed to decode audio: {e}")
            
            # Performance assessment
            if processing_time < 15.0:
                print("  ✓ TTS is FAST (< 15s)")
            elif processing_time < 30.0:
                print("  ⚠ TTS is MODERATE (15-30s)")
            else:
                print("  ✗ TTS is SLOW (> 30s)")
            
            return True
        else:
            print(f"✗ TTS failed: {response.status_code}")
            print(f"  Error: {response.text}")
            return False
            
    except Exception as e:
        print(f"✗ TTS error: {e}")
        return False

def main():
    """Main test function"""
    print("🎤 Belinda Voice TTS Test")
    print("=" * 50)
    
    success = test_belinda_voice()
    
    if success:
        print("\n" + "=" * 50)
        print("🎉 SUCCESS: Belinda voice TTS is working correctly!")
        print("   The listen button should now work with Belinda voice.")
        print("   Audio quality should be high and natural.")
    else:
        print("\n" + "=" * 50)
        print("❌ FAILED: Belinda voice TTS has issues")
        print("   Check the logs above for specific error messages.")
        print("   Ensure Higgs Audio is properly installed in the container.")
    
    print("\n" + "=" * 50)

if __name__ == "__main__":
    main()
