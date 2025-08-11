#!/usr/bin/env python3
"""
Test script for real-time streaming transcription improvements
"""

import asyncio
import time
import base64
import requests
import json

def test_realtime_streaming():
    """Test the real-time streaming transcription"""
    
    # Test configuration
    base_url = "http://localhost:9000"
    session_id = f"realtime_test_{int(time.time())}"
    
    print(f"Testing real-time streaming with session: {session_id}")
    
    # Create a simple test audio chunk (silence)
    test_audio_data = b'\x00' * 4000  # 4KB of silence
    test_audio_base64 = base64.b64encode(test_audio_data).decode('utf-8')
    
    # Test multiple chunks to simulate real-time streaming
    chunk_count = 20
    total_time = 0
    last_text = ""
    
    print(f"Sending {chunk_count} audio chunks for real-time streaming...")
    
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
                text = result.get('data', {}).get('text', '')
                partial_text = result.get('data', {}).get('partialText', '')
                is_partial = result.get('data', {}).get('isPartial', False)
                
                print(f"Chunk {i+1}: {chunk_time:.3f}s - Status: {status}")
                
                if text != last_text:
                    print(f"  Text updated: '{text}'")
                    if partial_text:
                        print(f"  Partial text: '{partial_text}'")
                    if is_partial:
                        print(f"  (Partial result)")
                    last_text = text
                
            else:
                print(f"Chunk {i+1}: Error {response.status_code}")
                
        except Exception as e:
            print(f"Chunk {i+1}: Error - {e}")
        
        # Small delay to simulate real-time streaming
        time.sleep(0.1)
    
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
            final_text = result.get('data', {}).get('text', 'No text')
            is_final = result.get('data', {}).get('isFinal', False)
            print(f"Final transcription: '{final_text}' (Final: {is_final})")
        else:
            print(f"Final transcription error: {response.status_code}")
            
    except Exception as e:
        print(f"Final transcription error: {e}")

if __name__ == "__main__":
    test_realtime_streaming()
