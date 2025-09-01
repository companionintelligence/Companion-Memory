import React from 'react';
import { AudioTranscript } from '@ci/speech';

/**
 * Demo page showcasing the audio chunking and real-time transcription functionality.
 * This demonstrates the integration between frontend audio capture and backend STT processing.
 */
export function AudioDemoPage() {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-4">
              Audio Chunking & Transcription Demo
            </h1>
            <p className="text-gray-600 max-w-2xl mx-auto">
              This demo showcases real-time audio chunking and transcript streaming. 
              The system captures microphone audio, chunks it into optimal segments, 
              and streams transcription results in real-time using WebSocket connections.
            </p>
          </div>

          {/* Main Audio Transcript Component */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4">Live Transcription</h2>
            <AudioTranscript 
              serverUrl={`ws://${window.location.hostname}:3030/audio-stream`}
              chunkingOptions={{
                chunkDurationMs: 2000,  // 2-second chunks
                overlapMs: 200,         // 200ms overlap for accuracy
                sampleRate: 16000,      // 16kHz optimized for speech
                channels: 1,            // Mono audio
              }}
              showControls={true}
              showStats={true}
              className="border rounded-lg p-4 bg-gray-50"
            />
          </div>

          {/* Technical Details */}
          <div className="grid md:grid-cols-2 gap-6 mb-8">
            <div className="bg-gray-50 p-6 rounded-lg">
              <h3 className="font-semibold text-lg mb-3">🎵 Audio Processing</h3>
              <ul className="space-y-2 text-sm text-gray-600">
                <li>• <strong>Real-time chunking:</strong> 2-second segments with 200ms overlap</li>
                <li>• <strong>Format optimization:</strong> 16kHz mono PCM16 for speech recognition</li>
                <li>• <strong>Web Audio API:</strong> Direct microphone capture with noise reduction</li>
                <li>• <strong>Buffer management:</strong> Automatic chunk size optimization (8KB-64KB)</li>
              </ul>
            </div>

            <div className="bg-gray-50 p-6 rounded-lg">
              <h3 className="font-semibold text-lg mb-3">📡 Streaming Architecture</h3>
              <ul className="space-y-2 text-sm text-gray-600">
                <li>• <strong>WebSocket streaming:</strong> Low-latency bidirectional communication</li>
                <li>• <strong>STT integration:</strong> Leverages existing speech services (port 9001)</li>
                <li>• <strong>Multi-stream support:</strong> Concurrent audio processing</li>
                <li>• <strong>Error recovery:</strong> Automatic reconnection and state management</li>
              </ul>
            </div>
          </div>

          {/* Usage Examples */}
          <div className="mb-8">
            <h3 className="text-lg font-semibold mb-4">Integration Examples</h3>
            
            <div className="bg-gray-900 text-gray-100 p-4 rounded-lg mb-4">
              <h4 className="text-sm font-semibold text-gray-300 mb-2">React Hook Usage:</h4>
              <pre className="text-xs overflow-x-auto">
{`import { useAudioChunking, useTranscriptStream } from '@ci/speech';

// Audio capture with chunking
const { startRecording, stopRecording, isRecording } = useAudioChunking({
  onChunk: (chunk) => sendToServer(chunk),
  options: { chunkDurationMs: 2000, sampleRate: 16000 }
});

// Real-time transcript streaming  
const { transcriptSegments, interimText, isConnected } = useTranscriptStream({
  serverUrl: 'ws://localhost:3030/audio-stream',
  streamId: 'voice-chat-001'
});`}
              </pre>
            </div>

            <div className="bg-gray-900 text-gray-100 p-4 rounded-lg">
              <h4 className="text-sm font-semibold text-gray-300 mb-2">Backend Service Usage:</h4>
              <pre className="text-xs overflow-x-auto">
{`// Create audio chunking stream
const audioStream = audioChunkingService.createStream('stream-001', {
  chunkDurationMs: 2000,
  overlapMs: 200,
  sampleRate: 16000
});

// Process chunks for transcription
const transcriptStream = transcriptStreamService.createStream('stream-001');
audioStream.on('chunk', (chunk) => transcriptStream.processChunk(chunk));`}
              </pre>
            </div>
          </div>

          {/* Status and Features */}
          <div className="border-t pt-6">
            <h3 className="text-lg font-semibold mb-4">🚀 Ready for Viseme Integration</h3>
            <p className="text-gray-600 mb-4">
              This audio chunking and transcription architecture provides the foundation for advanced 
              voice features including viseme generation, lip-sync, and real-time conversation analysis.
            </p>
            
            <div className="flex flex-wrap gap-2">
              <span className="px-3 py-1 bg-green-100 text-green-800 text-xs rounded-full">
                ✅ Real-time Processing
              </span>
              <span className="px-3 py-1 bg-green-100 text-green-800 text-xs rounded-full">
                ✅ WebSocket Streaming
              </span>
              <span className="px-3 py-1 bg-green-100 text-green-800 text-xs rounded-full">
                ✅ STT Integration
              </span>
              <span className="px-3 py-1 bg-green-100 text-green-800 text-xs rounded-full">
                ✅ Multi-stream Support
              </span>
              <span className="px-3 py-1 bg-blue-100 text-blue-800 text-xs rounded-full">
                🔄 Viseme Ready
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AudioDemoPage;