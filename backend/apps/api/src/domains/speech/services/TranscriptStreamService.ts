import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { AudioChunk } from './AudioChunkingService';
import { ProxyService } from '@ci/common/services/ProxyService';
import config from '@ci/configuration';

export interface TranscriptSegment {
  id: string;
  text: string;
  confidence: number;
  startTime: number;
  endTime: number;
  isFinal: boolean;
  audioChunkId: string;
}

export interface TranscriptStream {
  streamId: string;
  segments: TranscriptSegment[];
  currentText: string;
  isComplete: boolean;
  error?: string;
}

@Injectable()
export class TranscriptStreamService extends EventEmitter {
  private readonly logger = new Logger(TranscriptStreamService.name);
  private readonly activeStreams = new Map<string, TranscriptStreamProcessor>();

  constructor(private readonly proxyService: ProxyService) {
    super();
  }

  /**
   * Creates a new transcript stream processor
   */
  createStream(streamId: string): TranscriptStreamProcessor {
    const processor = new TranscriptStreamProcessor(streamId, this.proxyService, this.logger);
    
    processor.on('segment', (segment: TranscriptSegment) => {
      this.emit('segment', streamId, segment);
    });

    processor.on('interim', (text: string) => {
      this.emit('interim', streamId, text);
    });

    processor.on('error', (error: Error) => {
      this.emit('error', streamId, error);
    });

    processor.on('complete', () => {
      this.activeStreams.delete(streamId);
      this.emit('streamComplete', streamId);
    });

    this.activeStreams.set(streamId, processor);
    return processor;
  }

  /**
   * Gets an existing stream processor
   */
  getStream(streamId: string): TranscriptStreamProcessor | undefined {
    return this.activeStreams.get(streamId);
  }

  /**
   * Closes a stream and cleans up resources
   */
  closeStream(streamId: string): void {
    const processor = this.activeStreams.get(streamId);
    if (processor) {
      processor.close();
      this.activeStreams.delete(streamId);
    }
  }

  /**
   * Gets the number of active streams
   */
  getActiveStreamCount(): number {
    return this.activeStreams.size;
  }
}

class TranscriptStreamProcessor extends EventEmitter {
  private segments: TranscriptSegment[] = [];
  private segmentCounter = 0;
  private closed = false;
  private currentInterimText = '';

  constructor(
    private readonly streamId: string,
    private readonly proxyService: ProxyService,
    private readonly logger: Logger,
  ) {
    super();
    this.logger.debug(`Created transcript stream processor for ${streamId}`);
  }

  /**
   * Processes an audio chunk for transcription
   */
  async processAudioChunk(audioChunk: AudioChunk): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      this.logger.debug(`Processing audio chunk ${audioChunk.id} for transcription`);
      
      // Convert audio chunk to format expected by STT service
      const formData = this.createFormData(audioChunk);
      
      // Send to STT service
      const transcriptResult = await this.sendToSTTService(formData);
      
      if (transcriptResult) {
        this.processTranscriptResult(transcriptResult, audioChunk);
      }
    } catch (error) {
      this.logger.error(`Error processing audio chunk ${audioChunk.id}:`, error);
      this.emit('error', error);
    }
  }

  /**
   * Creates FormData for STT service request
   */
  private createFormData(audioChunk: AudioChunk): FormData {
    const formData = new FormData();
    
    // Create a blob from the audio data
    const audioBlob = new Blob([audioChunk.data], { 
      type: 'audio/wav' 
    });
    
    formData.append('audio', audioBlob, `chunk-${audioChunk.id}.wav`);
    formData.append('format', audioChunk.format);
    formData.append('sampleRate', audioChunk.sampleRate.toString());
    formData.append('channels', audioChunk.channels.toString());
    formData.append('interim', 'true'); // Request interim results
    
    return formData;
  }

  /**
   * Sends audio data to STT service
   */
  private async sendToSTTService(formData: FormData): Promise<any> {
    try {
      const response = await fetch(`${config.services.stt.host}/transcribe-stream`, {
        method: 'POST',
        body: formData,
        headers: {
          'Accept': 'application/json',
        }
      });

      if (!response.ok) {
        throw new Error(`STT service error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.error('Error calling STT service:', error);
      throw error;
    }
  }

  /**
   * Processes the result from STT service
   */
  private processTranscriptResult(result: any, audioChunk: AudioChunk): void {
    try {
      // Handle different response formats from STT service
      if (result.alternatives && result.alternatives.length > 0) {
        const alternative = result.alternatives[0];
        const text = alternative.transcript || '';
        const confidence = alternative.confidence || 0.0;
        const isFinal = result.is_final || false;

        if (isFinal) {
          // Create final segment
          const segment: TranscriptSegment = {
            id: `${this.streamId}-segment-${++this.segmentCounter}`,
            text: text,
            confidence: confidence,
            startTime: audioChunk.timestamp,
            endTime: audioChunk.timestamp + audioChunk.duration,
            isFinal: true,
            audioChunkId: audioChunk.id,
          };

          this.segments.push(segment);
          this.emit('segment', segment);
          
          // Clear interim text
          this.currentInterimText = '';
        } else {
          // Handle interim result
          this.currentInterimText = text;
          this.emit('interim', text);
        }
      } else if (result.text) {
        // Simple text result
        const segment: TranscriptSegment = {
          id: `${this.streamId}-segment-${++this.segmentCounter}`,
          text: result.text,
          confidence: result.confidence || 0.8,
          startTime: audioChunk.timestamp,
          endTime: audioChunk.timestamp + audioChunk.duration,
          isFinal: true,
          audioChunkId: audioChunk.id,
        };

        this.segments.push(segment);
        this.emit('segment', segment);
      }
    } catch (error) {
      this.logger.error('Error processing transcript result:', error);
      this.emit('error', error);
    }
  }

  /**
   * Gets the current full transcript
   */
  getFullTranscript(): string {
    const finalText = this.segments
      .filter(s => s.isFinal)
      .map(s => s.text)
      .join(' ');
    
    return this.currentInterimText 
      ? `${finalText} ${this.currentInterimText}`.trim()
      : finalText;
  }

  /**
   * Gets all segments
   */
  getSegments(): TranscriptSegment[] {
    return [...this.segments];
  }

  /**
   * Gets stream statistics
   */
  getStats() {
    return {
      streamId: this.streamId,
      segmentsProcessed: this.segments.length,
      finalSegments: this.segments.filter(s => s.isFinal).length,
      currentInterimText: this.currentInterimText,
      closed: this.closed,
    };
  }

  /**
   * Closes the processor and finalizes transcript
   */
  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    
    // If there's interim text, create a final segment
    if (this.currentInterimText) {
      const finalSegment: TranscriptSegment = {
        id: `${this.streamId}-segment-${++this.segmentCounter}`,
        text: this.currentInterimText,
        confidence: 0.5, // Lower confidence for interim-to-final conversion
        startTime: Date.now(),
        endTime: Date.now(),
        isFinal: true,
        audioChunkId: 'final-interim',
      };
      
      this.segments.push(finalSegment);
      this.emit('segment', finalSegment);
    }

    this.emit('complete');
    this.removeAllListeners();
  }
}