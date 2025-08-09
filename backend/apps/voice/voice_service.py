#!/usr/bin/env python3
"""
WhisperX Voice Processing Service
Handles real-time speech-to-text transcription using WhisperX
"""

import os
import base64
import tempfile
import logging
from typing import Dict, Any, Optional
from pathlib import Path

import torch
import whisperx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import subprocess
import io
import time

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(title="WhisperX Voice Service", version="1.0.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for model and device
model = None
device = None
compute_type = None
diarization_pipeline = None

# Session management for streaming audio
audio_sessions = {}  # session_id -> {audio_buffer, last_transcription, start_time}

class TranscriptionRequest(BaseModel):
    audio_data: str  # Base64 encoded audio
    sample_rate: int = 16000
    language: str = "en"
    model_size: str = "base"
    enable_diarization: bool = False
    sessionId: Optional[str] = None # Added for streaming

class TranscriptionResponse(BaseModel):
    text: str
    segments: list
    language: str
    confidence: float
    speakers: list = []

class TTSRequest(BaseModel):
    text: str
    voice: str = "alloy"  # Default voice
    speed: float = 1.0    # Speed multiplier
    pitch: float = 1.0    # Pitch multiplier

class TTSResponse(BaseModel):
    audio_data: str  # Base64 encoded audio
    duration: float
    sample_rate: int

def convert_audio_to_wav(audio_data: bytes, input_format: str = "webm") -> bytes:
    """Convert audio data to WAV format using ffmpeg"""
    try:
        logger.info(f"Converting audio: {len(audio_data)} bytes, format: {input_format}")
        logger.info(f"First 100 bytes: {audio_data[:100]}")
        
        # Validate input data
        if len(audio_data) < 50:
            logger.error("Audio data too small for conversion")
            raise ValueError("Audio data too small")
        
        # Create temporary input file
        with tempfile.NamedTemporaryFile(suffix=f".{input_format}", delete=False) as input_file:
            input_file.write(audio_data)
            input_path = input_file.name
        
        # Create temporary output file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output_file:
            output_path = output_file.name
        
        try:
            # Convert using ffmpeg with more detailed error handling
            cmd = [
                "ffmpeg", "-y",  # Overwrite output file
                "-i", input_path,  # Input file
                "-acodec", "pcm_s16le",  # 16-bit PCM
                "-ar", "16000",  # 16kHz sample rate
                "-ac", "1",  # Mono
                "-f", "wav",  # WAV format
                output_path  # Output file
            ]
            
            logger.info(f"Running ffmpeg command: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0:
                logger.error(f"FFmpeg conversion failed with return code {result.returncode}")
                logger.error(f"FFmpeg stderr: {result.stderr}")
                logger.error(f"FFmpeg stdout: {result.stdout}")
                
                # Check if output file was created despite error
                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    logger.info("FFmpeg created output file despite error, attempting to use it")
                else:
                    logger.error("No output file created by FFmpeg")
                    raise RuntimeError(f"FFmpeg conversion failed: {result.stderr}")
            
            # Read converted audio
            if os.path.exists(output_path):
                with open(output_path, "rb") as f:
                    wav_data = f.read()
                
                if len(wav_data) > 0:
                    logger.info(f"Audio converted successfully: {len(audio_data)} -> {len(wav_data)} bytes")
                    return wav_data
                else:
                    logger.error("FFmpeg output file is empty")
                    raise RuntimeError("FFmpeg output file is empty")
            else:
                logger.error("FFmpeg output file does not exist")
                raise RuntimeError("FFmpeg output file does not exist")
            
        finally:
            # Clean up temporary files
            try:
                if os.path.exists(input_path):
                    os.unlink(input_path)
                if os.path.exists(output_path):
                    os.unlink(output_path)
            except Exception as e:
                logger.warning(f"Failed to clean up temporary files: {e}")
            
    except Exception as e:
        logger.error(f"Audio conversion failed: {str(e)}")
        raise RuntimeError(f"Failed to convert audio: {str(e)}")

def load_whisperx_model(model_size: str = "base") -> tuple:
    """Load WhisperX model with specified size"""
    global model, device, compute_type
    
    if model is not None:
        return model, device, compute_type
    
    logger.info(f"Loading WhisperX model: {model_size}")
    
    # Set device
    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    
    logger.info(f"Using device: {device}, compute type: {compute_type}")
    
    # Load model
    model = whisperx.load_model(
        model_size, 
        device, 
        compute_type=compute_type,
        language="en"
    )
    
    logger.info("WhisperX model loaded successfully")
    return model, device, compute_type

def load_diarization_model():
    """Load speaker diarization model"""
    global diarization_pipeline
    
    if diarization_pipeline is not None:
        return diarization_pipeline
    
    try:
        logger.info("Loading speaker diarization model...")
        from pyannote.audio import Pipeline
        
        # Skip diarization for now since it requires HuggingFace token
        logger.warning("Skipping diarization model loading - requires HuggingFace token")
        return None
        
    except Exception as e:
        logger.warning(f"Failed to load diarization model: {e}")
        return None

def perform_speaker_diarization(audio_path: str, segments: list) -> list:
    """Perform speaker diarization on audio and assign speakers to segments"""
    try:
        pipeline = load_diarization_model()
        if pipeline is None:
            logger.warning("Diarization model not available, skipping speaker detection")
            return segments
        
        logger.info("Performing speaker diarization...")
        
        # Perform diarization
        diarization = pipeline(audio_path)
        
        # Extract speaker segments
        speaker_segments = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            speaker_segments.append({
                "start": turn.start,
                "end": turn.end,
                "speaker": speaker
            })
        
        # Assign speakers to transcription segments
        for segment in segments:
            segment_start = segment.get("start", 0)
            segment_end = segment.get("end", 0)
            
            # Find overlapping speaker segment
            assigned_speaker = "Unknown"
            max_overlap = 0
            
            for speaker_seg in speaker_segments:
                overlap_start = max(segment_start, speaker_seg["start"])
                overlap_end = min(segment_end, speaker_seg["end"])
                overlap = max(0, overlap_end - overlap_start)
                
                if overlap > max_overlap:
                    max_overlap = overlap
                    assigned_speaker = speaker_seg["speaker"]
            
            segment["speaker"] = assigned_speaker
        
        logger.info(f"Speaker diarization completed, found {len(speaker_segments)} speaker segments")
        return segments
        
    except Exception as e:
        logger.error(f"Speaker diarization failed: {e}")
        # Return segments without speaker information
        for segment in segments:
            segment["speaker"] = "Unknown"
        return segments

def transcribe_audio(audio_data: bytes, sample_rate: int = 16000, language: str = "en", enable_diarization: bool = False) -> Dict[str, Any]:
    """Transcribe audio data using WhisperX with improved sensitivity"""
    try:
        # Load model if not already loaded
        model, device, compute_type = load_whisperx_model()
        
        logger.info(f"Processing audio: {len(audio_data)} bytes, sample_rate: {sample_rate}")
        logger.info(f"First 20 bytes: {audio_data[:20]}")
        
        # Validate audio data
        if len(audio_data) < 100:
            logger.warning("Audio data too small, likely corrupted")
            return {
                "text": "",
                "segments": [],
                "language": language,
                "confidence": 0.0
            }
        
        # Detect audio format and convert to WAV format
        # Try to detect format from the first few bytes
        wav_audio_data = None
        
        if audio_data.startswith(b'RIFF'):
            # Already WAV format
            wav_audio_data = audio_data
            logger.info("Audio is already in WAV format")
        elif audio_data.startswith(b'\x1a\x45\xdf\xa3'):
            # WebM format
            logger.info("Detected WebM format, converting to WAV")
            wav_audio_data = convert_audio_to_wav(audio_data, "webm")
            logger.info("Converting WebM audio to WAV")
        elif audio_data.startswith(b'ftyp'):
            # MP4 format
            logger.info("Detected MP4 format, converting to WAV")
            wav_audio_data = convert_audio_to_wav(audio_data, "mp4")
            logger.info("Converting MP4 audio to WAV")
        elif audio_data.startswith(b'ID3') or audio_data.startswith(b'\xff\xfb'):
            # MP3 format
            logger.info("Detected MP3 format, converting to WAV")
            wav_audio_data = convert_audio_to_wav(audio_data, "mp3")
            logger.info("Converting MP3 audio to WAV")
        else:
            # Try different formats as fallback
            logger.info("Unknown audio format, trying WebM conversion")
            try:
                wav_audio_data = convert_audio_to_wav(audio_data, "webm")
                logger.info("WebM conversion successful")
            except Exception as e:
                logger.warning(f"WebM conversion failed: {e}")
                try:
                    wav_audio_data = convert_audio_to_wav(audio_data, "mp4")
                    logger.info("MP4 conversion successful")
                except Exception as e2:
                    logger.warning(f"MP4 conversion failed: {e2}")
                    # Last resort: try to use the original data as WAV
                    wav_audio_data = audio_data
                    logger.info("Using original audio data as WAV")
        
        # Validate converted audio
        if wav_audio_data is None or len(wav_audio_data) < 100:
            logger.error("Audio conversion failed or resulted in invalid data")
            return {
                "text": "",
                "segments": [],
                "language": language,
                "confidence": 0.0
            }
        
        logger.info(f"Audio conversion completed: {len(audio_data)} -> {len(wav_audio_data)} bytes")
        
        # Create temporary file for audio
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            temp_file.write(wav_audio_data)
            temp_file_path = temp_file.name
            logger.info(f"Created temporary file: {temp_file_path}")
        
        try:
            # Load audio using whisperx.load_audio which returns numpy array
            logger.info("Loading audio with WhisperX...")
            audio = whisperx.load_audio(temp_file_path, sample_rate)
            logger.info(f"Audio loaded: {len(audio)} samples, duration: {len(audio)/sample_rate:.2f}s")
            
            # Check if audio has content (not just silence) - 100x more sensitive
            if len(audio) == 0:
                logger.warning("Audio is empty (0 samples)")
                return {
                    "text": "",
                    "segments": [],
                    "language": language,
                    "confidence": 0.0
                }
            
            audio_rms = np.sqrt(np.mean(audio**2))
            logger.info(f"Audio RMS level: {audio_rms:.6f}")
            
            if np.isnan(audio_rms) or audio_rms < 0.00001:  # 100x more sensitive threshold (like the C++ example)
                logger.warning("Audio appears to be silence or very quiet")
                return {
                    "text": "",
                    "segments": [],
                    "language": language,
                    "confidence": 0.0
                }
            
            # Transcribe with numpy array - WhisperX expects numpy array
            logger.info("Starting WhisperX transcription...")
            result = model.transcribe(audio)
            
            logger.info(f"Raw transcription result: {result}")
            logger.info(f"Result type: {type(result)}")
            logger.info(f"Result keys: {result.keys() if hasattr(result, 'keys') else 'No keys'}")
            
            # Handle different result formats
            if hasattr(result, 'text'):
                transcription_text = result.text
            elif isinstance(result, dict) and 'text' in result:
                transcription_text = result['text']
            elif hasattr(result, '__getitem__') and 'text' in result:
                transcription_text = result['text']
            elif isinstance(result, dict) and 'segments' in result:
                # Extract text from segments
                transcription_text = ' '.join([seg.get('text', '').strip() for seg in result['segments']])
            else:
                logger.error(f"Unexpected result format: {result}")
                transcription_text = ""
            
            logger.info(f"Transcription text: '{transcription_text}'")
            
            # Perform alignment with proper format conversion
            if result["segments"]:
                try:
                    logger.info("Performing word-level alignment...")
                    # Convert audio to torch tensor for alignment
                    import torch
                    audio_tensor = torch.tensor(audio, dtype=torch.float32).unsqueeze(0)
                    
                    # Load alignment model
                    model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
                    
                    # Perform alignment
                    result = whisperx.align(result["segments"], model_a, metadata, audio_tensor, device, return_char_alignments=False)
                    logger.info("Word-level alignment completed successfully")
                    
                except Exception as e:
                    logger.warning(f"Alignment failed, using basic transcription: {e}")
                    # Continue with basic transcription if alignment fails
            
            # Calculate confidence
            if result["segments"]:
                confidence = np.mean([seg.get("avg_logprob", 0.0) for seg in result["segments"]])
            else:
                confidence = 0.0
            
            # Convert numpy types to native Python types for JSON serialization
            segments = []
            if result.get("segments"):
                for seg in result["segments"]:
                    try:
                        start_val = seg.get("start", 0.0)
                        end_val = seg.get("end", 0.0)
                        avg_logprob_val = seg.get("avg_logprob", 0.0)
                        no_speech_prob_val = seg.get("no_speech_prob", 0.0)
                        
                        # Ensure values are within valid ranges
                        start_val = max(0.0, min(float(start_val), 1e6))
                        end_val = max(0.0, min(float(end_val), 1e6))
                        avg_logprob_val = max(-1e6, min(float(avg_logprob_val), 1e6))
                        no_speech_prob_val = max(0.0, min(float(no_speech_prob_val), 1.0))
                        
                        segments.append({
                            "start": start_val,
                            "end": end_val,
                            "text": str(seg.get("text", "")),
                            "avg_logprob": avg_logprob_val,
                            "no_speech_prob": no_speech_prob_val
                        })
                    except (ValueError, TypeError) as e:
                        logger.warning(f"Failed to process segment: {e}")
                        continue
            
            # Perform speaker diarization if requested
            if enable_diarization and segments:
                try:
                    segments = perform_speaker_diarization(temp_file_path, segments)
                    logger.info("Speaker diarization completed")
                except Exception as e:
                    logger.warning(f"Speaker diarization failed: {e}")
                    # Add default speaker labels
                    for segment in segments:
                        segment["speaker"] = "Unknown"
            else:
                # Add default speaker labels
                for segment in segments:
                    segment["speaker"] = "Unknown"
            
            # Ensure confidence is within valid range
            confidence = max(0.0, min(float(confidence), 1.0))
            
            logger.info(f"Transcription completed successfully: '{transcription_text}'")
            
            return {
                "text": str(transcription_text),
                "segments": segments,
                "language": str(result.get("language", "en")),
                "confidence": confidence
            }
            
        finally:
            # Clean up temporary file
            try:
                os.unlink(temp_file_path)
                logger.info(f"Cleaned up temporary file: {temp_file_path}")
            except Exception as e:
                logger.warning(f"Failed to clean up temporary file: {e}")
            
    except Exception as e:
        logger.error(f"Error transcribing audio: {str(e)}")
        logger.error(f"Exception type: {type(e)}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise RuntimeError(f"Failed to transcribe audio: {str(e)}")

@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_endpoint(request: TranscriptionRequest):
    """Transcribe audio endpoint"""
    try:
        logger.info(f"Received transcription request: {len(request.audio_data)} chars base64")
        
        # Decode base64 audio
        audio_data = base64.b64decode(request.audio_data)
        logger.info(f"Decoded audio data: {len(audio_data)} bytes")
        logger.info(f"First 100 bytes: {audio_data[:100]}")
        
        # Check for common audio format headers
        if audio_data.startswith(b'RIFF'):
            format_detected = "WAV"
        elif audio_data.startswith(b'\x1a\x45\xdf\xa3'):
            format_detected = "WebM"
        elif audio_data.startswith(b'ftyp'):
            format_detected = "MP4"
        elif audio_data.startswith(b'ID3') or audio_data.startswith(b'\xff\xfb'):
            format_detected = "MP3"
        else:
            format_detected = "Unknown"
        
        logger.info(f"Detected format: {format_detected}")
        
        # Transcribe
        result = transcribe_audio(
            audio_data, 
            sample_rate=request.sample_rate,
            language=request.language,
            enable_diarization=request.enable_diarization
        )
        
        return TranscriptionResponse(**result)
        
    except Exception as e:
        logger.error(f"Error in transcribe endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/transcribe-stream")
async def transcribe_stream_endpoint(request: TranscriptionRequest):
    """Streaming transcription endpoint for real-time WAV chunks"""
    try:
        session_id = request.sessionId if hasattr(request, 'sessionId') else None
        if not session_id:
            raise HTTPException(status_code=400, detail="sessionId is required for streaming")
        
        logger.info(f"Received streaming transcription request for session: {session_id}")
        logger.info(f"Audio data size: {len(request.audio_data)} chars base64")
        
        # Decode base64 audio
        audio_data = base64.b64decode(request.audio_data)
        logger.info(f"Decoded audio data: {len(audio_data)} bytes")
        
        # Initialize session if it doesn't exist
        if session_id not in audio_sessions:
            audio_sessions[session_id] = {
                'audio_buffer': b'',
                'last_transcription': '',
                'start_time': time.time(),
                'chunk_count': 0
            }
            logger.info(f"Created new audio session: {session_id}")
        
        session = audio_sessions[session_id]
        session['chunk_count'] += 1
        
        # Append audio chunk to session buffer
        session['audio_buffer'] += audio_data
        logger.info(f"Session {session_id}: Total audio buffer size: {len(session['audio_buffer'])} bytes")
        
        # Only transcribe if we have enough audio (at least 0.5 seconds worth)
        # For compressed audio (WebM), we need much less data than raw PCM
        min_audio_size = 8000  # 8KB should be enough for 0.5 seconds of compressed audio
        
        if len(session['audio_buffer']) >= min_audio_size:
            try:
                # Transcribe the accumulated audio
                result = transcribe_audio(
                    session['audio_buffer'],
                    sample_rate=request.sample_rate,
                    language=request.language,
                    enable_diarization=False  # Disable for streaming
                )
                
                # Update session with latest transcription
                session['last_transcription'] = result.get('text', '')
                
                logger.info(f"Session {session_id}: Transcription: '{session['last_transcription']}'")
                
                return {
                    "type": "transcription",
                    "data": {
                        "text": session['last_transcription'],
                        "confidence": result.get('confidence', 0.8),
                        "isFinal": False,
                        "segments": result.get('segments', []),
                    },
                    "timestamp": time.time(),
                    "sessionId": session_id,
                    "chunkCount": session['chunk_count']
                }
                
            except Exception as e:
                logger.error(f"Transcription failed for session {session_id}: {str(e)}")
                return {
                    "type": "error",
                    "data": {
                        "message": f"Transcription failed: {str(e)}"
                    },
                    "timestamp": time.time(),
                    "sessionId": session_id
                }
        else:
            # Not enough audio yet, return status update
            logger.info(f"Session {session_id}: Not enough audio yet ({len(session['audio_buffer'])} bytes)")
            return {
                "type": "transcription",
                "data": {
                    "text": "",
                    "confidence": 0.0,
                    "isFinal": False,
                    "segments": [],
                    "status": "listening",
                    "audioSize": len(session['audio_buffer']),
                    "minSize": min_audio_size,
                },
                "timestamp": time.time(),
                "sessionId": session_id,
                "chunkCount": session['chunk_count']
            }
        
    except Exception as e:
        logger.error(f"Error in streaming transcribe endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/transcribe-stream-final")
async def transcribe_stream_final_endpoint(request: TranscriptionRequest):
    """Get final transcription for a streaming session"""
    try:
        session_id = request.sessionId if hasattr(request, 'sessionId') else None
        if not session_id:
            raise HTTPException(status_code=400, detail="sessionId is required")
        
        if session_id not in audio_sessions:
            raise HTTPException(status_code=404, detail="Session not found")
        
        session = audio_sessions[session_id]
        audio_buffer = session['audio_buffer']
        
        logger.info(f"Final transcription request for session: {session_id}")
        logger.info(f"Total audio buffer size: {len(audio_buffer)} bytes")
        
        if len(audio_buffer) == 0:
            # No audio recorded
            result = {
                "type": "transcription",
                "data": {
                    "text": "",
                    "confidence": 0.0,
                    "isFinal": True,
                    "segments": [],
                },
                "timestamp": time.time(),
                "sessionId": session_id
            }
        else:
            try:
                # Transcribe with diarization for final result
                transcription_result = transcribe_audio(
                    audio_buffer,
                    sample_rate=request.sample_rate,
                    language=request.language,
                    enable_diarization=True  # Enable for final transcription
                )
                
                result = {
                    "type": "transcription",
                    "data": {
                        "text": transcription_result.get('text', ''),
                        "confidence": transcription_result.get('confidence', 0.9),
                        "isFinal": True,
                        "segments": transcription_result.get('segments', []),
                        "speakers": transcription_result.get('speakers', []),
                    },
                    "timestamp": time.time(),
                    "sessionId": session_id
                }
                
                logger.info(f"Final transcription for session {session_id}: '{result['data']['text']}'")
                
            except Exception as e:
                logger.error(f"Final transcription failed for session {session_id}: {str(e)}")
                result = {
                    "type": "error",
                    "data": {
                        "message": f"Final transcription failed: {str(e)}"
                    },
                    "timestamp": time.time(),
                    "sessionId": session_id
                }
        
        # Clean up session
        del audio_sessions[session_id]
        logger.info(f"Cleaned up session: {session_id}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error in final transcription endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    try:
        # Check if Higgs Audio is available in the separate environment
        try:
            import subprocess
            result = subprocess.run([
                '/opt/higgs-env/bin/python', '-c',
                'import sys; sys.path.append("/opt/higgs-env/lib/python3.11/site-packages"); from boson_multimodal.model.higgs_audio.modeling_higgs_audio import HiggsAudioModel; print("SUCCESS")'
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode == 0 and "SUCCESS" in result.stdout:
                local_tts_available = True
                logger.info("Higgs Audio is available in separate environment")
            else:
                local_tts_available = False
                logger.warning(f"Higgs Audio not available: {result.stderr}")
        except Exception as tts_error:
            local_tts_available = False
            logger.warning(f"Higgs Audio not available: {str(tts_error)}")
        
        return {
            "status": "healthy", 
            "device": str(device) if device else None, 
            "model_loaded": bool(model is not None),
            "whisperx": bool(model is not None),
            "sesameai": local_tts_available  # Keep same field name for frontend compatibility
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return {
            "status": "unhealthy",
            "error": str(e),
            "whisperx": False,
            "sesameai": False
        }

@app.get("/models")
async def list_models():
    """List available model sizes"""
    return {
        "models": ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        "current_model": "base"
    }

@app.post("/transcribe-with-diarization", response_model=TranscriptionResponse)
async def transcribe_with_diarization_endpoint(request: TranscriptionRequest):
    """Transcribe audio with speaker diarization endpoint"""
    try:
        logger.info(f"Received transcription with diarization request: {len(request.audio_data)} chars base64")
        
        # Decode base64 audio
        audio_data = base64.b64decode(request.audio_data)
        logger.info(f"Decoded audio data: {len(audio_data)} bytes")
        
        # Transcribe with diarization enabled
        result = transcribe_audio(
            audio_data, 
            sample_rate=request.sample_rate,
            language=request.language,
            enable_diarization=True  # Force diarization for this endpoint
        )
        
        return TranscriptionResponse(**result)
        
    except Exception as e:
        logger.error(f"Error in transcribe with diarization endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/debug-audio")
async def debug_audio(request: TranscriptionRequest):
    """Debug endpoint to test audio processing without transcription"""
    try:
        # Decode base64 audio
        audio_data = base64.b64decode(request.audio_data)
        
        logger.info(f"Debug audio: {len(audio_data)} bytes")
        
        # Convert audio to WAV format
        wav_audio_data = convert_audio_to_wav(audio_data, "webm")
        
        # Load audio and check properties
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            temp_file.write(wav_audio_data)
            temp_file_path = temp_file.name
        
        try:
            audio = whisperx.load_audio(temp_file_path, request.sample_rate)
            audio_rms = np.sqrt(np.mean(audio**2))
            
            # Ensure all values are JSON serializable
            duration_seconds = len(audio) / request.sample_rate
            if not (duration_seconds >= 0 and duration_seconds <= 1e6):  # Sanity check
                duration_seconds = 0.0
                
            rms_level = float(audio_rms)
            if not (rms_level >= 0 and rms_level <= 1e6):  # Sanity check
                rms_level = 0.0
                
            return {
                "original_size": int(len(audio_data)),
                "wav_size": int(len(wav_audio_data)),
                "audio_samples": int(len(audio)),
                "duration_seconds": float(duration_seconds),
                "rms_level": float(rms_level),
                "has_content": bool(audio_rms > 0.001)
            }
        finally:
            os.unlink(temp_file_path)
            
    except Exception as e:
        logger.error(f"Error in debug audio endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/test-audio")
async def test_audio_endpoint(request: TranscriptionRequest):
    """Test endpoint to debug audio data without transcription"""
    try:
        logger.info(f"Received test audio request: {len(request.audio_data)} chars base64")
        
        # Decode base64 audio
        audio_data = base64.b64decode(request.audio_data)
        logger.info(f"Decoded audio data: {len(audio_data)} bytes")
        logger.info(f"First 50 bytes: {audio_data[:50]}")
        
        # Check for common audio format headers
        if audio_data.startswith(b'RIFF'):
            format_detected = "WAV"
        elif audio_data.startswith(b'\x1a\x45\xdf\xa3'):
            format_detected = "WebM"
        elif audio_data.startswith(b'ftyp'):
            format_detected = "MP4"
        elif audio_data.startswith(b'ID3') or audio_data.startswith(b'\xff\xfb'):
            format_detected = "MP3"
        else:
            format_detected = "Unknown"
        
        logger.info(f"Detected format: {format_detected}")
        
        return {
            "status": "success",
            "original_size": len(request.audio_data),
            "decoded_size": len(audio_data),
            "format_detected": format_detected,
            "first_bytes": str(audio_data[:20])
        }
        
    except Exception as e:
        logger.error(f"Error in test audio endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

def create_wav_file(audio_data: np.ndarray, sample_rate: int = 22050) -> bytes:
    """Create a properly formatted WAV file from audio data"""
    import struct
    
    # Ensure audio data is 16-bit PCM
    if audio_data.dtype != np.int16:
        audio_data = (audio_data * 32767).astype(np.int16)
    
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(audio_data) * 2  # 2 bytes per sample
    
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
    
    return wav_header + audio_data.tobytes()

def generate_local_tts(text: str, voice: str = "alloy", speed: float = 1.0) -> bytes:
    """Generate TTS using Higgs Audio or fallback to placeholder"""
    try:
        import torch
        import subprocess
        import tempfile
        import json
        
        # Check if Higgs Audio is available and compatible
        if not hasattr(generate_local_tts, 'higgs_available'):
            try:
                # Try to use the separate Higgs Audio environment
                result = subprocess.run([
                    '/opt/higgs-env/bin/python', '-c',
                    'import sys; sys.path.append("/opt/higgs-env/lib/python3.11/site-packages"); from boson_multimodal.model.higgs_audio.modeling_higgs_audio import HiggsAudioModel; print("SUCCESS")'
                ], capture_output=True, text=True, timeout=10)
                
                if result.returncode == 0 and "SUCCESS" in result.stdout:
                    generate_local_tts.higgs_available = True
                    logger.info("Higgs Audio is available in separate environment")
                else:
                    generate_local_tts.higgs_available = False
                    logger.warning(f"Higgs Audio not available: {result.stderr}")
            except Exception as e:
                logger.warning(f"Higgs Audio not available due to compatibility issues: {str(e)}")
                generate_local_tts.higgs_available = False
        
        if not getattr(generate_local_tts, 'higgs_available', False):
            raise ImportError("Higgs Audio not available")
        
        logger.info(f"Generating Higgs Audio TTS: '{text[:50]}...' (voice: {voice}, speed: {speed})")
        
        # Create a temporary script to run Higgs Audio in the separate environment
        script_content = f'''
import sys
import torch
import tempfile
import json
import base64
import soundfile as sf
import io

# Add the Higgs Audio environment to the path
sys.path.append("/opt/higgs-env/lib/python3.11/site-packages")

try:
    from boson_multimodal.model.higgs_audio.modeling_higgs_audio import HiggsAudioModel
    from transformers import AutoTokenizer
    
    # Load model and tokenizer
    model_name = "boson-ai/higgs-audio-v2-base"
    model = HiggsAudioModel.from_pretrained(model_name, torch_dtype=torch.float16, device_map="auto")
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    
    # Prepare input
    inputs = tokenizer("{text}", return_tensors="pt", padding=True, truncation=True)
    
    # Move inputs to device
    device = next(model.parameters()).device
    inputs = {{k: v.to(device) for k, v in inputs.items()}}
    
    # Generate audio
    with torch.no_grad():
        audio_output = model.generate(
            **inputs,
            max_new_tokens=1024,
            do_sample=True,
            temperature=0.3,
            top_p=0.9,
            pad_token_id=tokenizer.eos_token_id,
            eos_token_id=tokenizer.eos_token_id
        )
    
    # Decode audio
    audio = model.decode_audio(audio_output[0], skip_special_tokens=True)
    
    # Convert to numpy array
    if isinstance(audio, torch.Tensor):
        audio = audio.cpu().numpy()
    
    # Ensure mono format
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)
    
    # Normalize audio
    if audio.max() > 0:
        audio = audio / audio.max() * 0.8
    
    # Convert to WAV format
    buffer = io.BytesIO()
    sf.write(buffer, audio, 22050, format='WAV')
    buffer.seek(0)
    
    # Return base64 encoded audio
    audio_data = buffer.read()
    print(base64.b64encode(audio_data).decode('utf-8'))
    
except Exception as e:
    print(f"ERROR: {{str(e)}}")
    sys.exit(1)
'''
        
        # Write the script to a temporary file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(script_content)
            script_path = f.name
        
        try:
            # Run the script in the Higgs Audio environment
            result = subprocess.run([
                '/opt/higgs-env/bin/python', script_path
            ], capture_output=True, text=True, timeout=60)
            
            if result.returncode == 0:
                # Decode the base64 audio data
                audio_data = base64.b64decode(result.stdout.strip())
                logger.info(f"Higgs Audio TTS successful: {len(audio_data)} bytes")
                return audio_data
            else:
                raise Exception(f"Higgs Audio failed: {result.stderr}")
                
        finally:
            # Clean up the temporary script
            import os
            os.unlink(script_path)
            
    except Exception as e:
        logger.error(f"Error in Higgs Audio TTS: {str(e)}")
        # Fall back to placeholder audio if Higgs Audio fails
        logger.warning("Higgs Audio failed, using placeholder audio")
        
        # Create placeholder audio
        import numpy as np
        
        # Create a simple sine wave tone
        sample_rate = 22050
        duration = 2.0  # seconds
        frequency = 440  # Hz (A4 note)
        
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        audio = np.sin(2 * np.pi * frequency * t) * 0.3
        
        # Create WAV file
        wav_data = create_wav_file(audio, sample_rate)
        
        logger.info(f"Generated placeholder TTS audio: {len(wav_data)} bytes")
        
        return wav_data

@app.post("/tts", response_model=TTSResponse)
async def text_to_speech_endpoint(request: TTSRequest):
    """Convert text to speech using local TTS"""
    try:
        logger.info(f"Received TTS request: '{request.text[:50]}...' (voice: {request.voice})")
        
        # Use local TTS
        try:
            audio_data = generate_local_tts(request.text, request.voice, request.speed)
            audio_base64 = base64.b64encode(audio_data).decode('utf-8')
            
            # Estimate duration (rough calculation)
            duration = len(request.text.split()) * 0.5  # ~0.5 seconds per word
            
            logger.info(f"Generated local TTS audio: {len(audio_data)} bytes")
            
            return TTSResponse(
                audio_data=audio_base64,
                duration=duration,
                sample_rate=22050  # Local TTS uses 22kHz
            )
        except Exception as e:
            logger.error(f"Local TTS failed: {str(e)}")
            # Fall back to placeholder audio if local TTS fails
            logger.warning("Local TTS failed, using placeholder audio")
            
            # Create placeholder audio
            import numpy as np
            
            # Create a simple sine wave tone
            sample_rate = 22050
            duration = 2.0  # seconds
            frequency = 440  # Hz (A4 note)
            
            t = np.linspace(0, duration, int(sample_rate * duration), False)
            audio = np.sin(2 * np.pi * frequency * t) * 0.3
            
            # Create WAV file
            wav_data = create_wav_file(audio, sample_rate)
            
            # Convert to base64
            audio_base64 = base64.b64encode(wav_data).decode('utf-8')
            
            logger.info(f"Generated placeholder TTS audio: {len(wav_data)} bytes")
            
            return TTSResponse(
                audio_data=audio_base64,
                duration=duration,
                sample_rate=sample_rate
            )
        
    except Exception as e:
        logger.error(f"Error in TTS endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    # Load models on startup
    try:
        load_whisperx_model()
        logger.info("WhisperX model loaded successfully")
        
        # Try to load diarization model (optional)
        try:
            load_diarization_model()
            logger.info("Speaker diarization model loaded successfully")
        except Exception as e:
            logger.warning(f"Failed to load diarization model: {str(e)}")
            logger.info("Speaker diarization will be disabled")
        
        logger.info("WhisperX service started successfully")
    except Exception as e:
        logger.error(f"Failed to load WhisperX model: {str(e)}")
        exit(1)
    
    # Run server
    uvicorn.run(app, host="0.0.0.0", port=9000) 