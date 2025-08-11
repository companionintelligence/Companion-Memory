import { useState, useEffect, useRef } from 'react';

import { Portal, fetchJson, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Textarea, cn } from '@ci/shadcn';
import { Mic, Square, Volume2 } from '@ci/shadcn/icons';
import { useNavigate, useParams } from 'react-router-dom';

import { ModelSelector } from '@/components/ModelSelector';
import { useAuth, useModel } from '@/hooks';
import { voiceClient } from '../ChatPage/voiceClient';
import type { VoiceStreamResponse } from '../ChatPage/voiceClient';

// Utility function to convert binary data to base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

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
  
  // Chat history state
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  
  // Voice-related state
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcribedText, setTranscribedText] = useState('');
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [voiceServiceStatus, setVoiceServiceStatus] = useState<{ whisperx: boolean; localTTS: boolean } | null>(null);
  const [isPlayingTTS, setIsPlayingTTS] = useState(false);
  const audioLevelIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Check voice service status and pre-load Higgs Audio on mount
  useEffect(() => {
    const checkVoiceServiceStatus = async () => {
      try {
        const status = await voiceClient.healthCheck();
        setVoiceServiceStatus({ whisperx: status.whisperx, localTTS: status.localTTS });
        
        // Pre-load Higgs Audio model for faster TTS
        try {
          console.log('Pre-loading Higgs Audio model...');
          const preloadResult = await voiceClient.preloadHiggsAudio();
          console.log('Higgs Audio pre-load result:', preloadResult);
          
          if (preloadResult.status === 'loaded' || preloadResult.status === 'already_loaded') {
            console.log('Higgs Audio model is ready for TTS');
          } else {
            console.warn('Higgs Audio model pre-load failed:', preloadResult.message);
          }
        } catch (preloadError) {
          console.warn('Failed to pre-load Higgs Audio model:', preloadError);
          // Don't fail the entire voice service check for this
        }
      } catch (error) {
        console.error('Failed to check voice service status:', error);
        setVoiceServiceStatus({ whisperx: false, localTTS: false });
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

      let assistantResponse = '';
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        if (value) {
          assistantResponse += value;
          setOutput(assistantResponse);
        }
      }
      
      // Add the assistant's response to chat history
      if (assistantResponse.trim()) {
        setChatHistory(prev => [...prev, { role: 'assistant', content: assistantResponse }]);
      }
      
      // Clear the input field for the next message
      setInput('');
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

  // Handle text-to-speech
  const handleTextToSpeech = async () => {
    const lastAssistantMessage = chatHistory
      .filter(msg => msg.role === 'assistant')
      .pop();
    
    if (!lastAssistantMessage?.content.trim()) {
      return;
    }

    try {
      setIsPlayingTTS(true);
      
      // Get TTS audio from voice service using local TTS
      const ttsResult = await voiceClient.textToSpeech(lastAssistantMessage.content, "alloy", 1.0, 1.0);
      
      // Convert base64 audio to blob
      const audioData = atob(ttsResult.audioData);
      const audioArray = new Uint8Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        audioArray[i] = audioData.charCodeAt(i);
      }
      
      // Create blob - Higgs Audio returns WAV format
      const audioBlob = new Blob([audioArray], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(audioBlob);
      
      // Play the audio
      const audio = new Audio(audioUrl);
      
      // Add better error handling and logging
      audio.onloadstart = () => console.log('Audio loading started');
      audio.oncanplay = () => console.log('Audio can play');
      audio.oncanplaythrough = () => console.log('Audio can play through');
      audio.onloadeddata = () => console.log('Audio data loaded');
      
      audio.onended = () => {
        console.log('Audio playback ended');
        setIsPlayingTTS(false);
        URL.revokeObjectURL(audioUrl);
      };
      
      audio.onerror = (e) => {
        console.error('Audio playback error:', e);
        console.error('Audio error details:', audio.error);
        setIsPlayingTTS(false);
        URL.revokeObjectURL(audioUrl);
      };
      
      // Try to play the audio
      try {
        await audio.play();
        console.log('Audio playback started successfully');
      } catch (playError) {
        console.error('Failed to start audio playback:', playError);
        setIsPlayingTTS(false);
        URL.revokeObjectURL(audioUrl);
      }
      
    } catch (error) {
      console.error('Text-to-speech failed:', error);
      setIsPlayingTTS(false);
    }
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
        setInput(''); // Clear input field when exiting voice mode
        
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

      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });

      // Create audio context for level monitoring
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);
      
      setAudioContext(audioContext);
      setAnalyser(analyserNode);

      // Determine supported MIME type - prefer WebM with Opus codec for better quality
      const mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/wav'
      ];
      
      const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type)) || 'audio/webm';
      console.log('Supported MIME types:', mimeTypes.filter(type => MediaRecorder.isTypeSupported(type)));
      console.log('Using MIME type:', mimeType);
      
      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType,
        audioBitsPerSecond: 256000,
      });

      // Collect audio chunks
      const audioChunks: Blob[] = [];
      
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      // When recording stops, process the audio
      recorder.onstop = async () => {
        try {
          // Create audio blob
          const audioBlob = new Blob(audioChunks, { type: mimeType });
          console.log('Recording completed, audio size:', audioBlob.size, 'bytes');
          
          // Convert to base64
          const arrayBuffer = await audioBlob.arrayBuffer();
          const base64Audio = arrayBufferToBase64(arrayBuffer);
          
          console.log('Sending audio for transcription...');
          console.log('Audio blob size:', audioBlob.size, 'bytes');
          console.log('Base64 size:', base64Audio.length, 'chars');
          
          // Send to backend for transcription
          const response = await voiceClient.transcribeAudio({
            audioData: base64Audio,
            sampleRate: 16000,
            channels: 1,
            language: 'en',
            modelSize: 'base',
            enableDiarization: false,
          });

          console.log('Transcription response:', response);
          
          if (response.text && response.text.trim()) {
            const transcribedText = response.text.trim();
            setTranscribedText(transcribedText);
            setInput(transcribedText);
            console.log('Transcription completed successfully:', transcribedText);
          } else {
            console.log('No transcription text received - audio may be silence or too short');
            setTranscribedText('No speech detected');
          }
          
        } catch (error) {
          console.error('Failed to process audio:', error);
        } finally {
          setIsRecording(false);
          setAudioLevel(0);
        }
      };

      recorder.start(100); // Collect chunks every 100ms
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

  // Handle stopping voice recording
  const handleStopRecording = async () => {
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

    } catch (error) {
      console.error('Failed to stop voice recording:', error);
      setIsRecording(false);
      setAudioLevel(0);
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
                disabled={voiceServiceStatus ? !voiceServiceStatus.whisperx : false}
                variant="outline"
                className="ml-auto"
                title={voiceServiceStatus && !voiceServiceStatus.whisperx ? 'Voice service not available' : 'Start voice input with real-time transcription'}
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

        <div className="space-y-2">
          <Card.Content
            ref={containerRef}
            className="space-y-4 max-h-96 overflow-y-auto"
          >
            {chatHistory.length === 0 && !isLoading && (
              <div className="text-sm text-muted-foreground text-center py-8">
                Start a conversation by typing or using voice input.
              </div>
            )}
            
            {chatHistory.map((message, index) => (
              <div
                key={index}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {message.content}
                </div>
              </div>
            ))}
            
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-muted text-foreground rounded-lg px-3 py-2 text-sm">
                  {output || 'Generating...'}
                </div>
              </div>
            )}
          </Card.Content>
          
          {chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'assistant' && (
            <div className="flex justify-end">
              <Button
                onClick={handleTextToSpeech}
                disabled={isPlayingTTS || (voiceServiceStatus ? !voiceServiceStatus.localTTS : false)}
                variant="outline"
                size="sm"
                title={voiceServiceStatus && !voiceServiceStatus.localTTS ? 'Local TTS not available' : 'Listen to the generated response using local TTS'}
              >
                <Volume2 size={16} className="mr-2" />
                {isPlayingTTS ? 'Playing...' : 'Listen'}
                {voiceServiceStatus && voiceServiceStatus.localTTS && (
                  <span className="text-xs text-green-600 ml-1">(Local TTS)</span>
                )}
                {voiceServiceStatus && !voiceServiceStatus.localTTS && (
                  <span className="text-xs text-muted-foreground ml-1">(Offline)</span>
                )}
              </Button>
            </div>
          )}
        </div>
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
