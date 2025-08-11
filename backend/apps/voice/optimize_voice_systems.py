#!/usr/bin/env python3
"""
Comprehensive Voice Systems Optimization Script
Tests and optimizes both Speech-to-Text (SST) and Text-to-Speech (TTS) systems
"""

import time
import base64
import requests
import json
import numpy as np
import subprocess
import sys
from typing import Dict, Any, Tuple

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

def test_health_check(base_url: str) -> Dict[str, Any]:
    """Test health check endpoint"""
    print("=== Health Check ===")
    try:
        response = requests.get(f"{base_url}/health", timeout=10)
        if response.status_code == 200:
            health = response.json()
            print(f"✓ Health check passed")
            print(f"  Status: {health.get('status', 'unknown')}")
            print(f"  WhisperX: {health.get('whisperx', False)}")
            print(f"  Higgs Audio: {health.get('higgs_audio_loaded', False)}")
            print(f"  SesameAI: {health.get('sesameai', False)}")
            return health
        else:
            print(f"✗ Health check failed: {response.status_code}")
            return {}
    except Exception as e:
        print(f"✗ Health check error: {e}")
        return {}

def test_sst_performance(base_url: str) -> Tuple[bool, float]:
    """Test Speech-to-Text performance"""
    print("\n=== Speech-to-Text Performance Test ===")
    
    # Create test audio
    print("Creating test audio...")
    audio_data = create_test_audio(duration_seconds=3, frequency=440)
    wav_data = create_wav_header(audio_data)
    audio_base64 = base64.b64encode(wav_data).decode('utf-8')
    
    # Test transcription
    print("Testing transcription...")
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
            print(f"✓ SST completed in {processing_time:.3f}s")
            print(f"  Text: '{result.get('text', '')}'")
            print(f"  Language: {result.get('language', 'unknown')}")
            print(f"  Confidence: {result.get('confidence', 0.0):.3f}")
            print(f"  Segments: {len(result.get('segments', []))}")
            
            # Performance assessment
            if processing_time < 5.0:
                print("  ✓ SST is FAST (< 5s)")
            elif processing_time < 15.0:
                print("  ⚠ SST is MODERATE (5-15s)")
            else:
                print("  ✗ SST is SLOW (> 15s)")
            
            return True, processing_time
        else:
            print(f"✗ SST failed: {response.status_code}")
            print(f"  Error: {response.text}")
            return False, 0.0
            
    except Exception as e:
        print(f"✗ SST error: {e}")
        return False, 0.0

def test_tts_performance(base_url: str) -> Tuple[bool, float]:
    """Test Text-to-Speech performance"""
    print("\n=== Text-to-Speech Performance Test ===")
    
    test_text = "Hello, this is a test of the text to speech system. It should be fast and high quality."
    
    try:
        start_time = time.time()
        
        response = requests.post(
            f"{base_url}/tts",
            json={
                "text": test_text,
                "voice": "alloy",
                "speed": 1.0,
                "pitch": 1.0,
            },
            timeout=120
        )
        
        processing_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            print(f"✓ TTS completed in {processing_time:.3f}s")
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
            if processing_time < 10.0:
                print("  ✓ TTS is FAST (< 10s)")
            elif processing_time < 30.0:
                print("  ⚠ TTS is MODERATE (10-30s)")
            else:
                print("  ✗ TTS is SLOW (> 30s)")
            
            return True, processing_time
        else:
            print(f"✗ TTS failed: {response.status_code}")
            print(f"  Error: {response.text}")
            return False, 0.0
            
    except Exception as e:
        print(f"✗ TTS error: {e}")
        return False, 0.0

def test_higgs_preload(base_url: str) -> bool:
    """Test Higgs Audio pre-loading"""
    print("\n=== Higgs Audio Pre-load Test ===")
    
    try:
        start_time = time.time()
        
        response = requests.post(
            f"{base_url}/preload-higgs",
            timeout=300
        )
        
        loading_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            print(f"✓ Pre-load completed in {loading_time:.3f}s")
            print(f"  Status: {result.get('status', 'unknown')}")
            print(f"  Message: {result.get('message', 'No message')}")
            
            if result.get('status') in ['loaded', 'already_loaded']:
                print("  ✓ Higgs Audio model is ready")
                return True
            else:
                print(f"  ✗ Pre-load failed: {result.get('message', 'Unknown error')}")
                return False
        else:
            print(f"✗ Pre-load failed: {response.status_code}")
            print(f"  Error: {response.text}")
            return False
            
    except Exception as e:
        print(f"✗ Pre-load error: {e}")
        return False

def test_tts_after_preload(base_url: str) -> Tuple[bool, float]:
    """Test TTS performance after pre-loading"""
    print("\n=== TTS After Pre-load Test ===")
    
    test_text = "This is a test after pre-loading the model. It should be much faster now."
    
    try:
        start_time = time.time()
        
        response = requests.post(
            f"{base_url}/tts",
            json={
                "text": test_text,
                "voice": "alloy",
                "speed": 1.0,
                "pitch": 1.0,
            },
            timeout=60
        )
        
        processing_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            print(f"✓ TTS after pre-load completed in {processing_time:.3f}s")
            print(f"  Audio data length: {len(result.get('audio_data', ''))} chars")
            
            # Performance assessment
            if processing_time < 5.0:
                print("  ✓ TTS is VERY FAST after pre-load (< 5s)")
            elif processing_time < 15.0:
                print("  ✓ TTS is FAST after pre-load (5-15s)")
            else:
                print("  ⚠ TTS is still slow after pre-load (> 15s)")
            
            return True, processing_time
        else:
            print(f"✗ TTS after pre-load failed: {response.status_code}")
            return False, 0.0
            
    except Exception as e:
        print(f"✗ TTS after pre-load error: {e}")
        return False, 0.0

def generate_optimization_report(health: Dict[str, Any], sst_success: bool, sst_time: float, 
                               tts_success: bool, tts_time: float, preload_success: bool,
                               tts_after_preload_success: bool, tts_after_preload_time: float) -> str:
    """Generate optimization report"""
    
    report = "\n" + "="*60 + "\n"
    report += "VOICE SYSTEMS OPTIMIZATION REPORT\n"
    report += "="*60 + "\n\n"
    
    # System Status
    report += "SYSTEM STATUS:\n"
    report += f"  WhisperX (SST): {'✓ Available' if health.get('whisperx') else '✗ Not Available'}\n"
    report += f"  Higgs Audio (TTS): {'✓ Available' if health.get('sesameai') else '✗ Not Available'}\n"
    report += f"  Higgs Audio Loaded: {'✓ Yes' if health.get('higgs_audio_loaded') else '✗ No'}\n\n"
    
    # Performance Metrics
    report += "PERFORMANCE METRICS:\n"
    
    if sst_success:
        if sst_time < 5.0:
            report += f"  SST Speed: ✓ EXCELLENT ({sst_time:.2f}s)\n"
        elif sst_time < 15.0:
            report += f"  SST Speed: ⚠ GOOD ({sst_time:.2f}s)\n"
        else:
            report += f"  SST Speed: ✗ SLOW ({sst_time:.2f}s)\n"
    else:
        report += "  SST Speed: ✗ FAILED\n"
    
    if tts_success:
        if tts_time < 10.0:
            report += f"  TTS Speed (Cold): ✓ EXCELLENT ({tts_time:.2f}s)\n"
        elif tts_time < 30.0:
            report += f"  TTS Speed (Cold): ⚠ GOOD ({tts_time:.2f}s)\n"
        else:
            report += f"  TTS Speed (Cold): ✗ SLOW ({tts_time:.2f}s)\n"
    else:
        report += "  TTS Speed (Cold): ✗ FAILED\n"
    
    if tts_after_preload_success:
        if tts_after_preload_time < 5.0:
            report += f"  TTS Speed (Warm): ✓ EXCELLENT ({tts_after_preload_time:.2f}s)\n"
        elif tts_after_preload_time < 15.0:
            report += f"  TTS Speed (Warm): ⚠ GOOD ({tts_after_preload_time:.2f}s)\n"
        else:
            report += f"  TTS Speed (Warm): ✗ SLOW ({tts_after_preload_time:.2f}s)\n"
    else:
        report += "  TTS Speed (Warm): ✗ FAILED\n"
    
    # Optimization Status
    report += "\nOPTIMIZATION STATUS:\n"
    
    if sst_success and sst_time < 15.0:
        report += "  SST: ✓ OPTIMIZED\n"
    else:
        report += "  SST: ✗ NEEDS OPTIMIZATION\n"
    
    if tts_after_preload_success and tts_after_preload_time < 15.0:
        report += "  TTS: ✓ OPTIMIZED (with pre-loading)\n"
    else:
        report += "  TTS: ✗ NEEDS OPTIMIZATION\n"
    
    if preload_success:
        report += "  Pre-loading: ✓ WORKING\n"
    else:
        report += "  Pre-loading: ✗ NOT WORKING\n"
    
    # Recommendations
    report += "\nRECOMMENDATIONS:\n"
    
    if not health.get('whisperx'):
        report += "  • Install/configure WhisperX for SST\n"
    
    if not health.get('sesameai'):
        report += "  • Install/configure Higgs Audio for TTS\n"
    
    if sst_time > 15.0:
        report += "  • Optimize SST processing (reduce model size, improve audio conversion)\n"
    
    if tts_time > 30.0:
        report += "  • Optimize TTS processing (ensure model caching, reduce generation parameters)\n"
    
    if not preload_success:
        report += "  • Fix Higgs Audio pre-loading mechanism\n"
    
    if tts_after_preload_time > 15.0:
        report += "  • Ensure Higgs Audio model is properly cached\n"
    
    report += "\n" + "="*60 + "\n"
    
    return report

def main():
    """Main optimization function"""
    base_url = "http://localhost:9000"
    
    print("🎤 Voice Systems Optimization Script")
    print("Testing and optimizing SST and TTS performance...\n")
    
    # Test 1: Health Check
    health = test_health_check(base_url)
    if not health:
        print("✗ Cannot proceed - voice service is not responding")
        return
    
    # Test 2: SST Performance
    sst_success, sst_time = test_sst_performance(base_url)
    
    # Test 3: TTS Performance (cold start)
    tts_success, tts_time = test_tts_performance(base_url)
    
    # Test 4: Higgs Audio Pre-load
    preload_success = test_higgs_preload(base_url)
    
    # Test 5: TTS Performance (after pre-load)
    tts_after_preload_success = False
    tts_after_preload_time = 0.0
    if preload_success:
        tts_after_preload_success, tts_after_preload_time = test_tts_after_preload(base_url)
    
    # Generate and display report
    report = generate_optimization_report(
        health, sst_success, sst_time, tts_success, tts_time, 
        preload_success, tts_after_preload_success, tts_after_preload_time
    )
    
    print(report)
    
    # Save report to file
    with open('voice_optimization_report.txt', 'w') as f:
        f.write(report)
    
    print("Report saved to: voice_optimization_report.txt")

if __name__ == "__main__":
    main()
