#!/usr/bin/env python3
"""
Test script for Piper TTS functionality
"""

import os
import sys
import requests
import json
import base64

def test_piper_tts():
    """Test Piper TTS functionality"""
    
    # Set environment variable to use Piper
    os.environ['TTS_ENGINE'] = 'piper'
    
    # Import the voice service functions
    sys.path.append('.')
    from voice_service import load_piper_model, generate_piper_tts
    
    print("=== Testing Piper TTS ===")
    
    # Test 1: Load Piper model
    print("\n1. Loading Piper model...")
    try:
        success = load_piper_model()
        if success:
            print("   ✓ Piper model loaded successfully")
        else:
            print("   ✗ Failed to load Piper model")
            return False
    except Exception as e:
        print(f"   ✗ Error loading Piper model: {e}")
        return False
    
    # Test 2: Generate TTS
    print("\n2. Generating TTS...")
    test_text = "Hello, this is a test of the Piper text-to-speech system."
    try:
        audio_data = generate_piper_tts(test_text, voice="amy", speed=1.0)
        print(f"   ✓ Generated audio: {len(audio_data)} bytes")
        
        # Save audio to file for testing
        with open("test_piper_output.wav", "wb") as f:
            f.write(audio_data)
        print("   ✓ Saved audio to test_piper_output.wav")
        
    except Exception as e:
        print(f"   ✗ Error generating TTS: {e}")
        return False
    
    # Test 3: Test via HTTP endpoint
    print("\n3. Testing HTTP endpoint...")
    try:
        response = requests.post(
            "http://localhost:9000/tts",
            json={
                "text": test_text,
                "voice": "amy",
                "speed": 1.0
            },
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            print(f"   ✓ HTTP endpoint successful: {len(result.get('audio_data', ''))} chars base64")
        else:
            print(f"   ✗ HTTP endpoint failed: {response.status_code}")
            print(f"   Response: {response.text}")
            return False
            
    except Exception as e:
        print(f"   ✗ Error testing HTTP endpoint: {e}")
        return False
    
    print("\n=== All tests passed! ===")
    return True

def test_higgs_tts():
    """Test Higgs Audio TTS functionality"""
    
    # Set environment variable to use Higgs
    os.environ['TTS_ENGINE'] = 'higgs'
    
    print("\n=== Testing Higgs Audio TTS ===")
    
    # Test via HTTP endpoint
    print("\n1. Testing HTTP endpoint...")
    test_text = "Hello, this is a test of the Higgs Audio text-to-speech system."
    try:
        response = requests.post(
            "http://localhost:9000/tts",
            json={
                "text": test_text,
                "voice": "belinda",
                "speed": 1.0
            },
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            print(f"   ✓ HTTP endpoint successful: {len(result.get('audio_data', ''))} chars base64")
        else:
            print(f"   ✗ HTTP endpoint failed: {response.status_code}")
            print(f"   Response: {response.text}")
            return False
            
    except Exception as e:
        print(f"   ✗ Error testing HTTP endpoint: {e}")
        return False
    
    print("\n=== Higgs Audio test passed! ===")
    return True

if __name__ == "__main__":
    print("Piper TTS Test Script")
    print("=====================")
    
    # Test both engines
    piper_success = test_piper_tts()
    higgs_success = test_higgs_tts()
    
    print(f"\nResults:")
    print(f"  Piper TTS: {'✓ PASS' if piper_success else '✗ FAIL'}")
    print(f"  Higgs Audio: {'✓ PASS' if higgs_success else '✗ FAIL'}")
    
    if piper_success and higgs_success:
        print("\n🎉 All tests passed!")
        sys.exit(0)
    else:
        print("\n❌ Some tests failed!")
        sys.exit(1)
