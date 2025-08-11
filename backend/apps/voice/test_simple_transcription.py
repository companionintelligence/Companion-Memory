#!/usr/bin/env python3
"""
Test script for simple non-streaming transcription
"""

import time
import base64
import requests
import json

def test_simple_transcription():
    """Test the simple transcription endpoint"""
    
    # Test configuration
    base_url = "http://localhost:9000"
    
    print("Testing simple transcription endpoint")
    
    # Create a simple test audio chunk (silence)
    test_audio_data = b'\x00' * 16000  # 1 second of silence at 16kHz
    test_audio_base64 = base64.b64encode(test_audio_data).decode('utf-8')
    
    print(f"Test audio size: {len(test_audio_data)} bytes")
    
    try:
        start_time = time.time()
        
        response = requests.post(
            f"{base_url}/transcribe",
            json={
                "audio_data": test_audio_base64,
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
            print(f"Transcription completed in {processing_time:.3f}s")
            print(f"Response: {result}")
            
            if result.get('text'):
                print(f"Transcribed text: '{result['text']}'")
            else:
                print("No text transcribed (expected for silence)")
                
        else:
            print(f"Error {response.status_code}: {response.text}")
            
    except Exception as e:
        print(f"Test failed: {e}")

if __name__ == "__main__":
    test_simple_transcription()
