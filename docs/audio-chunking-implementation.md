# Audio Chunking and Transcript Stream Processing

This implementation provides real-time audio chunking and transcript streaming functionality for the CI-Server project.

## Architecture Overview

### Backend Services

1. **AudioChunkingService** - Handles real-time audio stream chunking
   - Configurable chunk duration, overlap, and audio parameters
   - Processes incoming audio streams into optimal chunks for STT
   - Manages multiple concurrent streams

2. **TranscriptStreamService** - Processes audio chunks for transcription
   - Sends audio chunks to existing STT service
   - Manages transcript segments and interim results
   - Handles confidence scoring and timing

3. **AudioStreamGateway** - WebSocket gateway for real-time communication
   - Handles client connections and stream management
   - Real-time audio data streaming
   - Broadcasts transcript updates to connected clients

### Frontend Package (@ci/speech)

1. **useAudioChunking** - React hook for audio capture and chunking
   - Captures microphone audio using Web Audio API
   - Converts audio to PCM16 format
   - Chunks audio data with configurable parameters

2. **useTranscriptStream** - React hook for WebSocket-based transcript streaming
   - Manages WebSocket connection to backend
   - Handles audio streaming and transcript reception
   - Provides connection state and error handling

3. **AudioTranscript** - React component for live transcription UI
   - Real-time display of interim and final transcripts
   - Recording controls and status indicators
   - Confidence scoring and statistics

## Key Features

- **Real-time Processing**: Low-latency audio chunking and transcript streaming
- **Configurable Parameters**: Adjustable chunk duration, overlap, sample rate, channels
- **Error Handling**: Robust connection management and error recovery
- **Multiple Stream Support**: Can handle concurrent audio streams
- **Confidence Scoring**: Displays transcript confidence levels
- **Interim Results**: Shows live transcription before finalization

## Integration with Existing Architecture

The implementation integrates with the existing speech infrastructure:
- Uses existing STT/TTS service configuration (ports 9001/9002)  
- Leverages existing ProxyService for STT communication
- Follows existing domain-driven architecture patterns
- Compatible with existing WebSocket infrastructure

## Usage Example

```tsx
import { AudioTranscript } from '@ci/speech';

function VoiceChat() {
  return (
    <AudioTranscript 
      serverUrl="ws://localhost:3030"
      chunkingOptions={{
        chunkDurationMs: 2000,
        sampleRate: 16000,
        channels: 1
      }}
      showControls={true}
      showStats={true}
    />
  );
}
```

## Configuration

Audio chunking parameters can be configured:

```typescript
interface ChunkingOptions {
  chunkDurationMs?: number;    // Default: 2000ms
  overlapMs?: number;          // Default: 200ms  
  sampleRate?: number;         // Default: 16000Hz
  channels?: number;           // Default: 1 (mono)
  minChunkSize?: number;       // Default: 8KB
  maxChunkSize?: number;       // Default: 64KB
}
```

## WebSocket Events

The system uses these WebSocket events:
- `startStream` - Begin audio streaming
- `audioData` - Send audio chunks  
- `stopStream` - End audio streaming
- `transcriptSegment` - Receive final transcript
- `interimTranscript` - Receive interim results
- `streamError` - Handle errors

This implementation provides a complete foundation for real-time voice transcription with optimal chunking for accuracy and performance.