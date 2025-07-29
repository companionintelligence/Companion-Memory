#!/usr/bin/env python3
"""
Simple test audio generator for testing WhisperX functionality
"""

import numpy as np
import wave
import base64
import io

def generate_test_audio(text="Hello world, this is a test", duration=3.0, sample_rate=16000):
    """Generate a simple test audio with the given text"""
    
    # Create a simple sine wave as audio (this won't be actual speech, but good for testing)
    t = np.linspace(0, duration, int(sample_rate * duration), False)
    
    # Generate a simple tone that varies in frequency
    frequency = 440 + 100 * np.sin(2 * np.pi * 0.5 * t)  # Varying frequency
    audio = 0.3 * np.sin(2 * np.pi * frequency * t)
    
    # Convert to 16-bit PCM
    audio = (audio * 32767).astype(np.int16)
    
    # Create WAV file in memory
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav_file:
        wav_file.setnchannels(1)  # Mono
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio.tobytes())
    
    # Get the WAV data
    wav_data = buffer.getvalue()
    
    # Convert to base64
    base64_audio = base64.b64encode(wav_data).decode('utf-8')
    
    return base64_audio, wav_data

if __name__ == "__main__":
    # Generate test audio
    base64_audio, wav_data = generate_test_audio("Hello world, this is a test of the enhanced WhisperX service", 5.0)
    
    print(f"Generated test audio: {len(wav_data)} bytes")
    print(f"Base64 audio (first 100 chars): {base64_audio[:100]}...")
    
    # Save the test audio for manual testing
    with open("test_audio.wav", "wb") as f:
        f.write(wav_data)
    
    print("Test audio saved as test_audio.wav")
    print("\nYou can use this base64 string to test the WhisperX API:")
    print(base64_audio) 