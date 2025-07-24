import { useState, useEffect, useRef } from 'react';

import { Portal, fetchJson, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Textarea, cn } from '@ci/shadcn';
import { Mic, Square } from '@ci/shadcn/icons';
import { useNavigate, useParams } from 'react-router-dom';

import { ModelSelector } from '@/components/ModelSelector';
import { useAuth, useModel } from '@/hooks';
import { voiceClient } from '../ChatPage/voiceClient';
import type { VoiceStreamResponse } from '../ChatPage/voiceClient';

interface Thread {
  id: string;
  name: string | null;
  model: string;
  description: string | null;
}

export function ChatThreadingPage() {
  usePageTitle('Chat - Companion Intelligence');

  const [{ authToken }] = useAuth();
  const [{ selectedModel }] = useModel();

  const { id } = useParams<{ id: string }>();

  // TODO: Load the thread when the page loads, show a spinner when it's loading.

  const navigate = useNavigate();

  const isNew = !id; // we're on /chat/new

  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(id ?? null);
  const threadName = useLongPollForThreadName(threadId);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Voice-related state
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcribedText, setTranscribedText] = useState('');
  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(null);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [voiceServiceStatus, setVoiceServiceStatus] = useState<{ whisperx: boolean; sesameai: boolean } | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioLevelIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Check voice service status on mount
  useEffect(() => {
    const checkVoiceServiceStatus = async () => {
      try {
        const status = await voiceClient.healthCheck();
        setVoiceServiceStatus({ whisperx: status.whisperx, sesameai: status.sesameai });
      } catch (error) {
        console.error('Failed to check voice service status:', error);
        setVoiceServiceStatus({ whisperx: false, sesameai: false });
      }
    };

    checkVoiceServiceStatus();
  }, []);

  useEffect(() => {
    if (isNew && threadId) {
      navigate(`/chat/${threadId}`, {
        replace: true,
      });
    }
  }, [isNew, threadId, navigate]);

  const handleSubmit = async () => {
    if (!input.trim()) {
      return;
    }

    setOutput('');
    setIsLoading(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch('/api/llm/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          prompt: input,
          model: selectedModel,
          threadId,
        }),
        signal: controller.signal,
      });

      setThreadId(res.headers.get('X-Thread-Id') as string);

      if (!res.body) {
        throw new Error('No response body');
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        if (value) {
          setOutput((prev) => prev + value);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Stream error:', err);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
  };

  // Voice chat functionality
  const handleVoiceChat = async () => {
    if (!isVoiceMode) {
      // Enter voice mode
      setIsVoiceMode(true);
      setTranscribedText('');
    } else {
      // Exit voice mode - clean up resources
      setIsVoiceMode(false);
      
      if (isRecording) {
        // Stop recording if active
        await handleStopRecording();
      } else {
        // Just clean up state
        setIsRecording(false);
        setAudioLevel(0);
        setTranscribedText('');
        setVoiceSessionId(null);
        
        // Stop MediaRecorder if active
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        
        // Stop audio level monitoring
        if (audioLevelIntervalRef.current) {
          clearInterval(audioLevelIntervalRef.current);
          audioLevelIntervalRef.current = null;
        }
        
        // Close audio context
        if (audioContext) {
          await audioContext.close();
          setAudioContext(null);
          setAnalyser(null);
        }
      }
    }
  };

  // Handle starting voice recording
  const handleStartRecording = async () => {
    try {
      setIsRecording(true);
      setAudioLevel(0);
      setTranscribedText('');
      audioChunksRef.current = [];

      // Request microphone permissions and start recording with better audio quality
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: false, // Disable echo cancellation for better voice capture
          noiseSuppression: false, // Disable noise suppression for clearer voice
          autoGainControl: false, // Disable auto gain control for consistent levels
        } 
      });

      // Set up audio context for level monitoring
      const context = new AudioContext({ sampleRate: 16000 });
      const source = context.createMediaStreamSource(stream);
      const analyserNode = context.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);
      
      setAudioContext(context);
      setAnalyser(analyserNode);

      // Start voice session with backend - let the backend generate the session ID
      const sessionResponse = await voiceClient.startVoiceStream();
      const sessionId = sessionResponse.sessionId;
      setVoiceSessionId(sessionId);
      console.log('Voice session created:', sessionId);
      
      // Verify session is active before proceeding
      try {
        const statusResponse = await fetch(`https://dev.companionintelligence.com/api/voice/session/${sessionId}/status`);
        if (statusResponse.ok) {
          const status = await statusResponse.json();
          console.log('Session status:', status);
        }
      } catch (error) {
        console.error('Failed to verify session status:', error);
      }

      // Set up MediaRecorder for audio capture with WAV format if possible
      let mimeType = 'audio/wav';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm;codecs=opus';
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/mp4';
      }
      
      console.log('Using MIME type:', mimeType);
      
      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType,
        audioBitsPerSecond: 128000, // Higher bitrate for better quality
      });

      recorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          
          console.log(`Audio chunk received: ${event.data.size} bytes, type: ${event.data.type}`);
          
          // Only process every 3rd chunk (1.5 seconds of audio) to reduce API calls
          if (audioChunksRef.current.length >= 3) {
            // Combine chunks into a single blob
            const combinedBlob = new Blob(audioChunksRef.current, { type: event.data.type });
            audioChunksRef.current = []; // Clear the buffer
            
            // Convert blob to base64 and send to backend
            const arrayBuffer = await combinedBlob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            const base64Audio = btoa(
              Array.from(uint8Array)
                .map(byte => String.fromCharCode(byte))
                .join('')
            );
            
            try {
              // Use the captured sessionId from the closure to ensure consistency
              if (!sessionId) {
                console.error('No active session ID available');
                return;
              }
              
              console.log('Processing audio chunk for session:', sessionId);
              const response = await voiceClient.processAudioChunk(sessionId, {
                audioData: base64Audio,
                sampleRate: 16000,
                channels: 1,
                timestamp: Date.now(),
              });

              console.log('WhisperX response:', response);
              console.log('Response type:', response.type);
              console.log('Response data:', response.data);
              console.log('Data type:', typeof response.data);

              if (response.type === 'transcription' && response.data && typeof response.data === 'object' && 'text' in response.data) {
                const transcriptionData = response.data as { text: string; confidence?: number; isFinal?: boolean };
                const newText = transcriptionData.text.trim();
                
                if (newText) {
                  setTranscribedText(prevText => {
                    // For streaming, append new text to existing transcription
                    if (prevText && !prevText.endsWith(newText)) {
                      return prevText + ' ' + newText;
                    }
                    return newText;
                  });
                }
              } else if (response.type === 'error') {
                console.error('WhisperX error:', response.data);
              }
            } catch (error) {
              console.error('Failed to process audio chunk:', error);
            }
          }
        }
      };

      recorder.start(500); // Capture in 0.5-second chunks for more frequent streaming updates
      setMediaRecorder(recorder);

      // Start audio level monitoring
      const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
      audioLevelIntervalRef.current = setInterval(() => {
        analyserNode.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        setAudioLevel((average / 255) * 100);
      }, 100);

    } catch (error) {
      console.error('Failed to start voice recording:', error);
      setIsRecording(false);
      setAudioLevel(0);
    }
  };

  // Handle stopping voice recording and sending
  const handleStopRecording = async () => {
    if (!voiceSessionId) return;

    try {
      setIsRecording(false);
      setAudioLevel(0);

      // Stop MediaRecorder
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }

      // Stop audio level monitoring
      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current);
        audioLevelIntervalRef.current = null;
      }

      // Close audio context
      if (audioContext) {
        await audioContext.close();
        setAudioContext(null);
        setAnalyser(null);
      }

      // Stop voice session and get final transcription
      const response = await voiceClient.stopVoiceStream(voiceSessionId);
      
      if (response.type === 'transcription' && response.data && typeof response.data === 'object' && 'text' in response.data) {
        const transcriptionData = response.data as { text: string; confidence?: number; isFinal?: boolean };
        const finalText = transcriptionData.text;
        setTranscribedText(finalText);

        // Set the transcribed text as input
        setInput(finalText);
      }

      setVoiceSessionId(null);
      audioChunksRef.current = [];

    } catch (error) {
      console.error('Failed to process voice message:', error);
      setIsRecording(false);
      setAudioLevel(0);
      setVoiceSessionId(null);
    }
  };

  useEffect(() => {
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [output]);

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item className={cn(threadId && 'hidden md:block')}>
              <Breadcrumb.Link href="/chat/list">Chat</Breadcrumb.Link>
            </Breadcrumb.Item>
            {threadId && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>{threadName || threadId}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Portal.Slot id="actions">
        <ModelSelector />
      </Portal.Slot>

      <Card className="w-full max-w-2xl mx-auto p-4 space-y-4">
        {!isVoiceMode ? (
          // Normal input mode
          <>
            <Textarea
              placeholder="Enter your prompt..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="resize-none"
            />

            <div className="flex gap-2">
              <Button onClick={handleSubmit} disabled={isLoading || selectedModel == null}>
                Generate
              </Button>
              <Button variant="destructive" onClick={handleStop} disabled={!isLoading}>
                Stop
              </Button>
              <Button
                onClick={handleVoiceChat}
                disabled={voiceServiceStatus && !voiceServiceStatus.whisperx}
                variant="outline"
                className="ml-auto"
                title={voiceServiceStatus && !voiceServiceStatus.whisperx ? 'WhisperX service not available' : 'Start voice input with real-time transcription'}
              >
                <Mic size={16} className="mr-2" />
                Voice
                {voiceServiceStatus && !voiceServiceStatus.whisperx && (
                  <span className="text-xs text-muted-foreground ml-1">(Offline)</span>
                )}
                {voiceServiceStatus && voiceServiceStatus.whisperx && (
                  <span className="text-xs text-green-600 ml-1">(Live)</span>
                )}
              </Button>
            </div>
          </>
        ) : (
          // Voice mode
          <>
            <div className="border border-input bg-background px-3 py-2 flex items-center gap-3 min-h-[80px]">
              {isRecording ? (
                <>
                  <AudioWaveform level={audioLevel} />
                  <div className="flex-1">
                    <span className="text-sm text-muted-foreground">
                      {transcribedText ? 'Real-time transcription:' : 'Listening... (speak now)'}
                    </span>
                    {transcribedText && (
                      <div className="text-sm font-medium text-foreground mt-1">
                        "{transcribedText}"
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1">
                  <span className="text-sm text-muted-foreground">
                    {transcribedText ? 'Final transcription:' : 'Click to start recording'}
                  </span>
                  {transcribedText && (
                    <div className="text-sm font-medium text-foreground mt-1">
                      "{transcribedText}"
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-2">
              {!isRecording ? (
                <Button onClick={handleStartRecording} className="flex-1">
                  <Mic size={16} className="mr-2" />
                  Start Recording
                </Button>
              ) : (
                <Button onClick={handleStopRecording} variant="destructive" className="flex-1">
                  <Square size={16} className="mr-2" />
                  Stop Recording
                </Button>
              )}
              <Button onClick={handleVoiceChat} variant="outline">
                Exit Voice
              </Button>
            </div>
          </>
        )}

        <Card.Content
          ref={containerRef}
          className="whitespace-pre-wrap text-sm bg-muted rounded-lg p-4 max-h-96 overflow-y-auto font-mono"
        >
          {output || (isLoading ? 'Generating...' : 'Response will appear here.')}
        </Card.Content>
      </Card>
    </>
  );
}

// TODO:
//   This should only be used on the initial thread creation.
//   Right now we're relying on this to get the name even when we probably
//   already know it (e.g. when a user loads an existing chat to add to it).
function useLongPollForThreadName(threadId?: string | null) {
  const [{ authToken }] = useAuth();

  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!threadId || name) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const thread: Thread = await fetchJson(`/api/threads/${threadId}?includeMessages=false`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });

        if (thread?.name) {
          setName(thread.name);
          clearInterval(interval);
        }
      } catch (err) {
        console.error('Polling failed:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [threadId, name]);

  return name;
}

// Simple waveform component for audio visualization
function AudioWaveform({ level }: { level: number }) {
  const bars = 5;
  const barHeight = Math.max(2, (level / 100) * 20);

  return (
    <div className="flex items-end gap-1 h-6">
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          className="w-1 bg-primary rounded-full transition-all duration-100"
          style={{
            height: `${barHeight * (0.5 + Math.random() * 0.5)}px`,
          }}
        />
      ))}
    </div>
  );
}
