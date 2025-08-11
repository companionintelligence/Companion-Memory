#!/usr/bin/env python3
"""
Test script for streaming optimization improvements
"""

import asyncio
import time
import base64
import requests
import json

def test_streaming_performance():
    """Test the streaming performance improvements"""
    
    # Test configuration
    base_url = "http://localhost:9000"
    session_id = f"test_session_{int(time.time())}"
    
    print(f"Testing streaming optimization with session: {session_id}")
    
    # Create a simple test audio chunk (silence)
    # In a real test, you'd use actual audio data
    test_audio_data = b'\x00' * 8000  # 8KB of silence
    test_audio_base64 = base64.b64encode(test_audio_data).decode('utf-8')
    
    # Test multiple chunks to simulate streaming
    chunk_count = 10
    total_time = 0
    
    print(f"Sending {chunk_count} audio chunks...")
    
    for i in range(chunk_count):
        start_time = time.time()
        
        try:
            response = requests.post(
                f"{base_url}/transcribe-stream",
                json={
                    "audio_data": test_audio_base64,
                    "sample_rate": 16000,
                    "language": "en",
                    "model_size": "base",
                    "enable_diarization": False,
                    "sessionId": session_id
                },
                timeout=10
            )
            
            if response.status_code == 200:
                result = response.json()
                chunk_time = time.time() - start_time
                total_time += chunk_time
                
                status = result.get('data', {}).get('status', 'unknown')
                print(f"Chunk {i+1}: {chunk_time:.3f}s - Status: {status}")
                
                if result.get('data', {}).get('text'):
                    print(f"  Transcription: {result['data']['text']}")
            else:
                print(f"Chunk {i+1}: Error {response.status_code}")
                
        except Exception as e:
            print(f"Chunk {i+1}: Error - {e}")
    
    avg_time = total_time / chunk_count if chunk_count > 0 else 0
    print(f"\nResults:")
    print(f"Total time: {total_time:.3f}s")
    print(f"Average time per chunk: {avg_time:.3f}s")
    print(f"Chunks per second: {1/avg_time:.1f}" if avg_time > 0 else "N/A")
    
    # Test final transcription
    try:
        print(f"\nTesting final transcription...")
        response = requests.post(
            f"{base_url}/transcribe-stream-final",
            json={
                "audio_data": "",
                "sample_rate": 16000,
                "language": "en",
                "model_size": "base",
                "enable_diarization": False,
                "sessionId": session_id
            },
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            print(f"Final transcription: {result.get('data', {}).get('text', 'No text')}")
        else:
            print(f"Final transcription error: {response.status_code}")
            
    except Exception as e:
        print(f"Final transcription error: {e}")

if __name__ == "__main__":
    test_streaming_performance()
