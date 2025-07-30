#!/usr/bin/env python3
"""
Test script for local TTS integration
"""

import os
import sys
import base64
import requests
import json

def test_local_tts():
    """Test gTTS functionality"""
    
    print("✅ Testing gTTS functionality")
    
    # Test text
    test_text = "Hello, this is a test of the Google text-to-speech service."
    
    print(f"🔄 Testing gTTS with text: '{test_text}'")
    
    try:
        from gtts import gTTS
        
        # Create gTTS object
        tts = gTTS(text=test_text, lang='en', slow=False)
        
        # Generate audio to file
        tts.save("test_gtts_output.mp3")
        
        print(f"✅ gTTS successful")
        print("✅ Test audio saved as 'test_gtts_output.mp3'")
        
        return True
            
    except Exception as e:
        print(f"❌ Error testing gTTS: {str(e)}")
        return False

def test_voice_service_tts():
    """Test the voice service TTS endpoint"""
    
    # Test text
    test_text = "Hello, this is a test of the voice service text-to-speech endpoint."
    
    # Voice service endpoint
    api_url = "http://localhost:9000/tts"
    
    # Prepare the request payload
    payload = {
        "text": test_text,
        "voice": "alloy",
        "speed": 1.0,
        "pitch": 1.0
    }
    
    headers = {
        "Content-Type": "application/json"
    }
    
    print(f"🔄 Testing voice service TTS endpoint with text: '{test_text}'")
    
    try:
        # Make the API request
        response = requests.post(api_url, json=payload, headers=headers, timeout=30)
        
        if response.status_code == 200:
            result = response.json()
            audio_data = base64.b64decode(result['audio_data'])
            print(f"✅ Voice service TTS successful: {len(audio_data)} bytes")
            
            # Save test audio file
            with open("test_voiceservice_output.mp3", "wb") as f:
                f.write(audio_data)
            print("✅ Test audio saved as 'test_voiceservice_output.mp3'")
            
            return True
        else:
            print(f"❌ Voice service TTS failed: {response.status_code}")
            print(f"Response: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Error testing voice service TTS: {str(e)}")
        return False

def test_health_check():
    """Test the voice service health check"""
    
    api_url = "http://localhost:9000/health"
    
    print("🔄 Testing voice service health check")
    
    try:
        response = requests.get(api_url, timeout=10)
        
        if response.status_code == 200:
            health = response.json()
            print("✅ Health check successful")
            print(f"Status: {health.get('status')}")
            print(f"WhisperX: {health.get('whisperx')}")
            print(f"Local TTS: {health.get('sesameai')}")
            return True
        else:
            print(f"❌ Health check failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Error testing health check: {str(e)}")
        return False

if __name__ == "__main__":
    print("🧪 Testing Local TTS Integration")
    print("=" * 50)
    
    # Test health check first
    if not test_health_check():
        print("\n❌ Voice service health check failed. Make sure the voice service is running.")
        sys.exit(1)
    
    print("\n" + "=" * 50)
    
    # Test direct local TTS
    print("Testing direct local TTS...")
    local_success = test_local_tts()
    
    print("\n" + "=" * 50)
    
    # Test voice service TTS endpoint
    print("Testing voice service TTS endpoint...")
    service_success = test_voice_service_tts()
    
    print("\n" + "=" * 50)
    
    # Summary
    if local_success and service_success:
        print("🎉 All tests passed! Local TTS integration is working correctly.")
    else:
        print("❌ Some tests failed. Check the output above for details.")
        sys.exit(1) 