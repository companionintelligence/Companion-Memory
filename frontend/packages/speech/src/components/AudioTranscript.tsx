import React from 'react';
import { useTranscriptStream } from '../hooks/useTranscriptStream';

interface AudioTranscriptProps {
  serverUrl?: string;
  streamId?: string;
  chunkingOptions?: {
    chunkDurationMs?: number;
    overlapMs?: number;
    sampleRate?: number;
    channels?: number;
  };
  className?: string;
  showControls?: boolean;
  showStats?: boolean;
}

export function AudioTranscript({ 
  serverUrl,
  streamId,
  chunkingOptions,
  className = '',
  showControls = true,
  showStats = false,
}: AudioTranscriptProps) {
  const {
    isRecording,
    isConnected,
    error,
    transcriptSegments,
    currentInterimText,
    toggleStream,
    getFullTranscript,
    getStreamStats,
  } = useTranscriptStream({
    serverUrl,
    streamId,
    chunkingOptions,
  });

  const fullTranscript = getFullTranscript();

  const handleToggleRecording = () => {
    toggleStream();
  };

  const handleGetStats = () => {
    getStreamStats();
  };

  return (
    <div className={`audio-transcript ${className}`}>
      {showControls && (
        <div className="controls" style={{ marginBottom: '1rem' }}>
          <button
            onClick={handleToggleRecording}
            disabled={!isConnected}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: isRecording ? '#dc3545' : '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: isConnected ? 'pointer' : 'not-allowed',
              marginRight: '0.5rem',
            }}
          >
            {isRecording ? 'Stop Recording' : 'Start Recording'}
          </button>
          
          {showStats && (
            <button
              onClick={handleGetStats}
              disabled={!isConnected}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isConnected ? 'pointer' : 'not-allowed',
                marginRight: '0.5rem',
              }}
            >
              Get Stats
            </button>
          )}
        </div>
      )}
      
      <div className="status" style={{ marginBottom: '1rem', fontSize: '0.9rem' }}>
        <div style={{ color: isConnected ? '#28a745' : '#dc3545' }}>
          Connection: {isConnected ? 'Connected' : 'Disconnected'}
        </div>
        {isRecording && (
          <div style={{ color: '#ffc107' }}>
            Recording: Active
          </div>
        )}
        {error && (
          <div style={{ color: '#dc3545' }}>
            Error: {error}
          </div>
        )}
      </div>
      
      <div className="transcript" style={{ 
        border: '1px solid #ddd',
        borderRadius: '4px',
        padding: '1rem',
        minHeight: '200px',
        backgroundColor: '#f8f9fa',
        fontFamily: 'monospace',
      }}>
        <div className="final-transcript" style={{ marginBottom: '0.5rem' }}>
          {transcriptSegments
            .filter(segment => segment.isFinal)
            .map(segment => (
              <span
                key={segment.id}
                style={{
                  opacity: segment.confidence > 0.8 ? 1 : 0.7,
                  fontWeight: segment.confidence > 0.9 ? 'bold' : 'normal',
                }}
                title={`Confidence: ${Math.round(segment.confidence * 100)}%`}
              >
                {segment.text}{' '}
              </span>
            ))}
        </div>
        
        {currentInterimText && (
          <div className="interim-transcript" style={{
            color: '#6c757d',
            fontStyle: 'italic',
            borderTop: currentInterimText ? '1px dashed #ddd' : 'none',
            paddingTop: currentInterimText ? '0.5rem' : '0',
          }}>
            {currentInterimText}
          </div>
        )}
        
        {!fullTranscript && !currentInterimText && (
          <div style={{ color: '#6c757d', fontStyle: 'italic' }}>
            {isRecording 
              ? 'Listening... Speak to see live transcription.'
              : 'Click "Start Recording" to begin voice transcription.'}
          </div>
        )}
      </div>
      
      {transcriptSegments.length > 0 && (
        <div className="transcript-stats" style={{
          marginTop: '1rem',
          fontSize: '0.8rem',
          color: '#6c757d',
        }}>
          Segments: {transcriptSegments.length} | 
          Final: {transcriptSegments.filter(s => s.isFinal).length} |
          Avg Confidence: {Math.round(
            transcriptSegments.reduce((sum, s) => sum + s.confidence, 0) / transcriptSegments.length * 100
          )}%
        </div>
      )}
    </div>
  );
}