# Audio Chunking Testing Guide

This guide provides comprehensive testing procedures for the audio chunking and transcript streaming architecture.

## Testing Architecture

### Backend Services Testing

#### 1. AudioChunkingService Test
```bash
# Navigate to backend API directory
cd backend/apps/api

# Run unit tests (once dependencies are resolved)
npm test -- AudioChunkingService

# Manual testing via Node.js REPL
node -e "
const { AudioChunkingService } = require('./src/domains/speech/services/AudioChunkingService');
const service = new AudioChunkingService();
const stream = service.createStream('test-001', { chunkDurationMs: 1000 });
console.log('AudioChunkingService loaded successfully');
"
```

#### 2. TranscriptStreamService Test
```bash
# Test STT service integration
curl -X POST http://localhost:9001/transcribe \
  -H "Content-Type: audio/wav" \
  --data-binary @test-audio.wav

# Verify ProxyService connection
node -e "
const { ProxyService } = require('./src/common/services/ProxyService');
const proxy = new ProxyService();
console.log('ProxyService integration verified');
"
```

#### 3. WebSocket Gateway Test
```bash
# Start backend API server
npm run start:dev

# Test WebSocket connection with wscat
npm install -g wscat
wscat -c ws://localhost:3030/audio-stream

# Send test messages
> {"type": "startStream", "streamId": "test-001", "options": {"sampleRate": 16000}}
```

### Frontend Package Testing

#### 1. Build @ci/speech Package
```bash
# Navigate to speech package
cd frontend/packages/speech

# Install dependencies and build
yarn install
yarn build

# Type checking
yarn typecheck

# Linting
yarn lint
```

#### 2. Hook Integration Tests
```tsx
// Test useAudioChunking hook
import { useAudioChunking } from '@ci/speech';

function TestAudioCapture() {
  const { startRecording, stopRecording, isRecording, error } = useAudioChunking({
    onChunk: (chunk) => console.log('Received chunk:', chunk.byteLength, 'bytes'),
    options: { chunkDurationMs: 1000 }
  });

  return (
    <div>
      <button onClick={startRecording} disabled={isRecording}>
        Start Recording
      </button>
      <button onClick={stopRecording} disabled={!isRecording}>
        Stop Recording
      </button>
      {error && <div>Error: {error}</div>}
    </div>
  );
}
```

#### 3. WebSocket Connection Test
```tsx
// Test useTranscriptStream hook
import { useTranscriptStream } from '@ci/speech';

function TestTranscriptStream() {
  const { 
    isConnected, 
    transcriptSegments, 
    interimText, 
    startStream, 
    stopStream 
  } = useTranscriptStream({
    serverUrl: 'ws://localhost:3030/audio-stream',
    streamId: 'test-transcript-001'
  });

  return (
    <div>
      <div>Status: {isConnected ? 'Connected' : 'Disconnected'}</div>
      <div>Interim: {interimText}</div>
      <div>Segments: {transcriptSegments.length}</div>
    </div>
  );
}
```

### Integration Testing

#### 1. End-to-End Audio Pipeline Test
```javascript
// Complete pipeline test
async function testAudioPipeline() {
  // 1. Start WebSocket connection
  const socket = io('ws://localhost:3030/audio-stream');
  
  // 2. Initialize audio capture
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mediaRecorder = new MediaRecorder(stream);
  
  // 3. Set up chunking
  const chunks = [];
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
      // Send chunk via WebSocket
      socket.emit('audioData', {
        streamId: 'test-001',
        audioData: event.data,
        options: { sampleRate: 16000 }
      });
    }
  };
  
  // 4. Listen for transcript results
  socket.on('transcriptSegment', (data) => {
    console.log('Transcript:', data.text, 'Confidence:', data.confidence);
  });
  
  // 5. Start recording
  mediaRecorder.start(2000); // 2-second chunks
  
  console.log('End-to-end pipeline test initiated');
}
```

#### 2. Demo Page Testing
```bash
# Start web application
cd frontend/apps/web
yarn dev

# Navigate to demo page
open http://localhost:3000/audio-demo

# Test functionality:
# 1. Click "Start Recording" button
# 2. Speak into microphone
# 3. Verify real-time transcript appears
# 4. Check WebSocket connection status
# 5. Verify audio chunks are being processed
```

### Performance Testing

#### 1. Chunk Processing Performance
```javascript
// Measure chunking performance
const startTime = performance.now();
const audioStream = audioChunkingService.createStream('perf-test', {
  chunkDurationMs: 2000,
  sampleRate: 16000
});

let chunkCount = 0;
audioStream.on('chunk', () => {
  chunkCount++;
  if (chunkCount === 100) {
    const endTime = performance.now();
    console.log(`Processed 100 chunks in ${endTime - startTime}ms`);
  }
});
```

#### 2. WebSocket Latency Test
```javascript
// Measure WebSocket round-trip latency
socket.emit('ping', { timestamp: Date.now() });
socket.on('pong', (data) => {
  const latency = Date.now() - data.timestamp;
  console.log(`WebSocket latency: ${latency}ms`);
});
```

### Error Testing

#### 1. Network Disconnection Test
```javascript
// Test WebSocket reconnection
socket.on('disconnect', () => {
  console.log('WebSocket disconnected, testing reconnection...');
});

socket.on('reconnect', () => {
  console.log('WebSocket reconnected successfully');
});

// Simulate network interruption
socket.disconnect();
setTimeout(() => socket.connect(), 5000);
```

#### 2. Audio Device Error Test
```javascript
// Test microphone access errors
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
} catch (error) {
  if (error.name === 'NotAllowedError') {
    console.log('Microphone permission denied');
  } else if (error.name === 'NotFoundError') {
    console.log('No microphone found');
  }
}
```

## Test Checklist

### Backend Services ✅
- [ ] AudioChunkingService creates streams successfully
- [ ] Audio chunks are generated with correct format
- [ ] TranscriptStreamService connects to STT service
- [ ] WebSocket gateway accepts connections
- [ ] Multiple concurrent streams are supported
- [ ] Error handling works correctly

### Frontend Package ✅
- [ ] @ci/speech package builds successfully
- [ ] All hooks export correctly
- [ ] useAudioChunking captures microphone audio
- [ ] useTranscriptStream connects via WebSocket
- [ ] AudioTranscript component renders properly
- [ ] TypeScript types are accurate

### Integration Testing ✅
- [ ] End-to-end audio pipeline works
- [ ] Real-time transcription appears
- [ ] WebSocket communication is stable
- [ ] Audio chunking parameters are respected
- [ ] STT service integration functions
- [ ] Demo page demonstrates all features

### Performance & Reliability ✅
- [ ] Low-latency audio processing (< 100ms)
- [ ] Stable WebSocket connections
- [ ] Memory usage is reasonable
- [ ] Error recovery works automatically
- [ ] Multiple users supported concurrently

This testing guide ensures the audio chunking and transcript streaming architecture is robust, performant, and ready for integration with Viseme work.