#!/usr/bin/env python3
"""
Standalone test script for TTS service with diarization
Tests the TTS endpoint with diarization enabled and disabled
"""

import asyncio
import httpx
import base64
import json
import sys
from datetime import datetime

# Configuration
TTS_SERVICE_URL = "http://localhost:9002"
TEST_TEXTS = [
    "Hello, this is a test of the text to speech service.",
    "The quick brown fox jumps over the lazy dog.",
    "Testing diarization with multiple speakers. First speaker says hello. Second speaker responds.",
]

async def test_tts_endpoint(text: str, enable_diarization: bool = True):
    """Test the TTS endpoint with given text"""
    print(f"\n{'='*60}")
    print(f"Testing TTS with diarization={'enabled' if enable_diarization else 'disabled'}")
    print(f"Text: {text[:50]}{'...' if len(text) > 50 else ''}")
    print(f"{'='*60}")
    
    try:
        async with httpx.AsyncClient() as client:
            # Make TTS request
            response = await client.post(
                f"{TTS_SERVICE_URL}/tts",
                json={
                    "text": text,
                    "speed": 1.0,
                    "voice_id": "default",
                    "enable_diarization": enable_diarization
                },
                timeout=60.0  # Longer timeout for diarization
            )
            
            if response.status_code != 200:
                print(f"❌ Error: HTTP {response.status_code}")
                print(f"Response: {response.text}")
                return False
            
            # Parse response
            result = response.json()
            
            # Display results
            print(f"✅ Success!")
            print(f"Audio format: {result['audio_format']}")
            print(f"Duration: {result['duration']:.2f} seconds")
            print(f"Sample rate: {result['sample_rate']} Hz")
            print(f"Voice used: {result['voice_used']}")
            print(f"Audio size: {len(base64.b64decode(result['audio_data']))} bytes")
            
            # Display diarization results if available
            if result.get('diarization'):
                print(f"\n📊 Diarization Results:")
                diarization = result['diarization']
                
                if diarization:
                    print(f"  Transcribed text: {diarization.get('text', 'N/A')}")
                    print(f"  Confidence: {diarization.get('confidence', 'N/A')}")
                    
                    # Display segments
                    segments = diarization.get('segments', [])
                    if segments:
                        print(f"  Segments: {len(segments)}")
                        for i, segment in enumerate(segments[:3]):  # Show first 3 segments
                            print(f"    [{i}] {segment.get('text', 'N/A')} (start: {segment.get('start', 'N/A')}s)")
                    
                    # Display speakers
                    speakers = diarization.get('speakers', [])
                    if speakers:
                        print(f"  Speakers detected: {len(speakers)}")
                else:
                    print("  ⚠️  Diarization returned no results")
            else:
                print("\n📊 No diarization data (disabled or unavailable)")
            
            # Save audio file for manual inspection
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"test_output_{timestamp}_{enable_diarization}.{result['audio_format']}"
            with open(filename, "wb") as f:
                f.write(base64.b64decode(result['audio_data']))
            print(f"\n💾 Audio saved to: {filename}")
            
            return True
            
    except httpx.ConnectError:
        print(f"❌ Error: Could not connect to TTS service at {TTS_SERVICE_URL}")
        print("Make sure the TTS service is running")
        return False
    except Exception as e:
        print(f"❌ Error: {type(e).__name__}: {e}")
        return False

async def check_service_health():
    """Check if TTS service is healthy"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{TTS_SERVICE_URL}/health")
            if response.status_code == 200:
                health = response.json()
                print(f"🏥 Service Health Check:")
                print(f"  Status: {health.get('status', 'unknown')}")
                print(f"  Voice model: {health.get('voice_model', 'unknown')}")
                return True
            else:
                print(f"❌ Health check failed: HTTP {response.status_code}")
                return False
    except Exception as e:
        print(f"❌ Health check error: {e}")
        return False

async def main():
    """Run all tests"""
    print("🚀 TTS Diarization Test Suite")
    print(f"Target: {TTS_SERVICE_URL}")
    
    # Check service health
    if not await check_service_health():
        print("\n⚠️  Service health check failed, but continuing with tests...")
    
    # Run tests
    success_count = 0
    total_tests = 0
    
    # Test 1: Simple text with diarization
    total_tests += 1
    if await test_tts_endpoint(TEST_TEXTS[0], enable_diarization=True):
        success_count += 1
    
    # Test 2: Same text without diarization
    total_tests += 1
    if await test_tts_endpoint(TEST_TEXTS[0], enable_diarization=False):
        success_count += 1
    
    # Test 3: Longer text with diarization
    total_tests += 1
    if await test_tts_endpoint(TEST_TEXTS[2], enable_diarization=True):
        success_count += 1
    
    # Summary
    print(f"\n{'='*60}")
    print(f"📈 Test Summary: {success_count}/{total_tests} passed")
    print(f"{'='*60}")
    
    return success_count == total_tests

if __name__ == "__main__":
    # Run the async main function
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
