import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface AudioChunk {
  id: string;
  data: Buffer;
  timestamp: number;
  duration: number;
  sampleRate: number;
  channels: number;
  format: string;
}

export interface ChunkingOptions {
  chunkDurationMs?: number;
  overlapMs?: number;
  minChunkSize?: number;
  maxChunkSize?: number;
  sampleRate?: number;
  channels?: number;
}

@Injectable()
export class AudioChunkingService extends EventEmitter {
  private readonly logger = new Logger(AudioChunkingService.name);
  private readonly activeStreams = new Map<string, AudioStreamProcessor>();

  constructor() {
    super();
  }

  /**
   * Creates a new audio stream processor for chunking incoming audio data
   */
  createStream(streamId: string, options: ChunkingOptions = {}): AudioStreamProcessor {
    const processor = new AudioStreamProcessor(streamId, options, this.logger);
    
    processor.on('chunk', (chunk: AudioChunk) => {
      this.emit('chunk', streamId, chunk);
    });

    processor.on('error', (error: Error) => {
      this.emit('error', streamId, error);
    });

    processor.on('end', () => {
      this.activeStreams.delete(streamId);
      this.emit('streamEnd', streamId);
    });

    this.activeStreams.set(streamId, processor);
    return processor;
  }

  /**
   * Gets an existing stream processor
   */
  getStream(streamId: string): AudioStreamProcessor | undefined {
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

class AudioStreamProcessor extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private chunkCounter = 0;
  private lastChunkTime = 0;
  private closed = false;

  private readonly defaultOptions: Required<ChunkingOptions> = {
    chunkDurationMs: 2000, // 2 seconds
    overlapMs: 200, // 200ms overlap
    minChunkSize: 8192, // 8KB minimum
    maxChunkSize: 65536, // 64KB maximum
    sampleRate: 16000, // 16kHz
    channels: 1, // Mono
  };

  private readonly options: Required<ChunkingOptions>;

  constructor(
    private readonly streamId: string,
    options: ChunkingOptions,
    private readonly logger: Logger,
  ) {
    super();
    this.options = { ...this.defaultOptions, ...options };
    this.logger.debug(`Created audio stream processor for ${streamId}`, this.options);
  }

  /**
   * Processes incoming audio data and emits chunks when ready
   */
  processAudio(audioData: Buffer): void {
    if (this.closed) {
      return;
    }

    try {
      // Append new data to buffer
      this.buffer = Buffer.concat([this.buffer, audioData]);

      // Calculate chunk size based on duration and audio format
      const bytesPerSample = 2; // 16-bit audio = 2 bytes per sample
      const bytesPerSecond = this.options.sampleRate * this.options.channels * bytesPerSample;
      const targetChunkSize = Math.floor((this.options.chunkDurationMs / 1000) * bytesPerSecond);
      const overlapSize = Math.floor((this.options.overlapMs / 1000) * bytesPerSecond);

      // Process chunks while we have enough data
      while (this.buffer.length >= targetChunkSize && !this.closed) {
        const chunkSize = Math.min(targetChunkSize, this.options.maxChunkSize);
        const chunk = this.buffer.subarray(0, chunkSize);
        
        // Remove processed data from buffer, keeping overlap
        const removeSize = Math.max(chunkSize - overlapSize, chunkSize / 2);
        this.buffer = this.buffer.subarray(removeSize);

        // Create chunk metadata
        const audioChunk: AudioChunk = {
          id: `${this.streamId}-${++this.chunkCounter}`,
          data: chunk,
          timestamp: Date.now(),
          duration: this.options.chunkDurationMs,
          sampleRate: this.options.sampleRate,
          channels: this.options.channels,
          format: 'pcm_s16le', // 16-bit PCM little-endian
        };

        this.emit('chunk', audioChunk);
        this.lastChunkTime = Date.now();
      }
    } catch (error) {
      this.logger.error(`Error processing audio for stream ${this.streamId}:`, error);
      this.emit('error', error);
    }
  }

  /**
   * Flushes any remaining audio data as a final chunk
   */
  flush(): void {
    if (this.closed || this.buffer.length === 0) {
      return;
    }

    try {
      // Create final chunk with remaining data
      const audioChunk: AudioChunk = {
        id: `${this.streamId}-${++this.chunkCounter}`,
        data: this.buffer,
        timestamp: Date.now(),
        duration: this.calculateActualDuration(this.buffer.length),
        sampleRate: this.options.sampleRate,
        channels: this.options.channels,
        format: 'pcm_s16le',
      };

      this.emit('chunk', audioChunk);
      this.buffer = Buffer.alloc(0);
    } catch (error) {
      this.logger.error(`Error flushing audio for stream ${this.streamId}:`, error);
      this.emit('error', error);
    }
  }

  /**
   * Closes the processor and cleans up resources
   */
  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.flush();
    this.emit('end');
    this.removeAllListeners();
  }

  /**
   * Calculates actual duration based on buffer size and audio format
   */
  private calculateActualDuration(bufferSize: number): number {
    const bytesPerSample = 2; // 16-bit audio
    const bytesPerSecond = this.options.sampleRate * this.options.channels * bytesPerSample;
    return Math.floor((bufferSize / bytesPerSecond) * 1000); // Return in milliseconds
  }

  /**
   * Gets processing statistics
   */
  getStats() {
    return {
      streamId: this.streamId,
      chunksProcessed: this.chunkCounter,
      bufferSize: this.buffer.length,
      lastChunkTime: this.lastChunkTime,
      closed: this.closed,
      options: this.options,
    };
  }
}