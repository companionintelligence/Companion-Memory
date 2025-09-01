import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { AudioChunkingService, AudioChunk, ChunkingOptions } from '../services/AudioChunkingService';
import { TranscriptStreamService, TranscriptSegment } from '../services/TranscriptStreamService';

interface AudioStreamMessage {
  streamId: string;
  audioData: ArrayBuffer;
  options?: ChunkingOptions;
}

interface StreamControlMessage {
  streamId: string;
  action: 'start' | 'stop' | 'pause' | 'resume';
}

@WebSocketGateway({
  namespace: '/audio-stream',
  cors: {
    origin: true,
  },
})
export class AudioStreamGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AudioStreamGateway.name);
  private readonly clientStreams = new Map<string, Set<string>>(); // socketId -> streamIds

  constructor(
    private readonly audioChunkingService: AudioChunkingService,
    private readonly transcriptStreamService: TranscriptStreamService,
  ) {
    // Listen for audio chunks and process them for transcription
    this.audioChunkingService.on('chunk', this.handleAudioChunk.bind(this));
    
    // Listen for transcript segments and broadcast to clients
    this.transcriptStreamService.on('segment', this.handleTranscriptSegment.bind(this));
    this.transcriptStreamService.on('interim', this.handleInterimTranscript.bind(this));
    
    // Listen for errors
    this.audioChunkingService.on('error', this.handleAudioError.bind(this));
    this.transcriptStreamService.on('error', this.handleTranscriptError.bind(this));
  }

  afterInit(server: Server) {
    this.logger.log('Audio Stream WebSocket Gateway initialized');
  }

  handleConnection(client: Socket, ...args: any[]) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientStreams.set(client.id, new Set());
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    
    // Clean up all streams for this client
    const streamIds = this.clientStreams.get(client.id);
    if (streamIds) {
      for (const streamId of streamIds) {
        this.cleanupStream(streamId);
      }
      this.clientStreams.delete(client.id);
    }
  }

  @SubscribeMessage('startStream')
  handleStartStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; options?: ChunkingOptions },
  ) {
    const { streamId, options } = data;
    
    try {
      this.logger.log(`Starting audio stream: ${streamId} for client: ${client.id}`);
      
      // Create audio chunking stream
      const audioStream = this.audioChunkingService.createStream(streamId, options);
      
      // Create transcript stream
      const transcriptStream = this.transcriptStreamService.createStream(streamId);
      
      // Track stream for this client
      const clientStreamIds = this.clientStreams.get(client.id) || new Set();
      clientStreamIds.add(streamId);
      this.clientStreams.set(client.id, clientStreamIds);
      
      // Join client to stream room for targeted updates
      client.join(`stream-${streamId}`);
      
      client.emit('streamStarted', { streamId, success: true });
    } catch (error) {
      this.logger.error(`Error starting stream ${streamId}:`, error);
      client.emit('streamError', { streamId, error: error.message });
    }
  }

  @SubscribeMessage('audioData')
  handleAudioData(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: AudioStreamMessage,
  ) {
    const { streamId, audioData } = data;
    
    try {
      const audioStream = this.audioChunkingService.getStream(streamId);
      if (!audioStream) {
        client.emit('streamError', { 
          streamId, 
          error: 'Stream not found. Please start the stream first.' 
        });
        return;
      }

      // Convert ArrayBuffer to Buffer and process
      const buffer = Buffer.from(audioData);
      audioStream.processAudio(buffer);
    } catch (error) {
      this.logger.error(`Error processing audio data for stream ${streamId}:`, error);
      client.emit('streamError', { streamId, error: error.message });
    }
  }

  @SubscribeMessage('stopStream')
  handleStopStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    const { streamId } = data;
    
    try {
      this.logger.log(`Stopping audio stream: ${streamId} for client: ${client.id}`);
      
      this.cleanupStream(streamId);
      
      // Remove from client's tracked streams
      const clientStreamIds = this.clientStreams.get(client.id);
      if (clientStreamIds) {
        clientStreamIds.delete(streamId);
      }
      
      client.leave(`stream-${streamId}`);
      client.emit('streamStopped', { streamId, success: true });
    } catch (error) {
      this.logger.error(`Error stopping stream ${streamId}:`, error);
      client.emit('streamError', { streamId, error: error.message });
    }
  }

  @SubscribeMessage('getStreamStats')
  handleGetStreamStats(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    const { streamId } = data;
    
    try {
      const audioStream = this.audioChunkingService.getStream(streamId);
      const transcriptStream = this.transcriptStreamService.getStream(streamId);
      
      const stats = {
        streamId,
        audio: audioStream?.getStats() || null,
        transcript: transcriptStream?.getStats() || null,
        exists: !!audioStream && !!transcriptStream,
      };
      
      client.emit('streamStats', stats);
    } catch (error) {
      this.logger.error(`Error getting stream stats for ${streamId}:`, error);
      client.emit('streamError', { streamId, error: error.message });
    }
  }

  /**
   * Handles audio chunks from the chunking service
   */
  private async handleAudioChunk(streamId: string, chunk: AudioChunk) {
    try {
      // Send chunk to transcript service
      const transcriptStream = this.transcriptStreamService.getStream(streamId);
      if (transcriptStream) {
        await transcriptStream.processAudioChunk(chunk);
      }
      
      // Notify clients about the chunk (for debugging/monitoring)
      this.server.to(`stream-${streamId}`).emit('audioChunk', {
        streamId,
        chunkId: chunk.id,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        size: chunk.data.length,
      });
    } catch (error) {
      this.logger.error(`Error handling audio chunk for stream ${streamId}:`, error);
      this.server.to(`stream-${streamId}`).emit('streamError', {
        streamId,
        error: 'Error processing audio chunk',
      });
    }
  }

  /**
   * Handles final transcript segments
   */
  private handleTranscriptSegment(streamId: string, segment: TranscriptSegment) {
    this.server.to(`stream-${streamId}`).emit('transcriptSegment', {
      streamId,
      segment,
    });
  }

  /**
   * Handles interim transcript updates
   */
  private handleInterimTranscript(streamId: string, text: string) {
    this.server.to(`stream-${streamId}`).emit('interimTranscript', {
      streamId,
      text,
    });
  }

  /**
   * Handles audio processing errors
   */
  private handleAudioError(streamId: string, error: Error) {
    this.logger.error(`Audio error for stream ${streamId}:`, error);
    this.server.to(`stream-${streamId}`).emit('streamError', {
      streamId,
      error: 'Audio processing error',
      details: error.message,
    });
  }

  /**
   * Handles transcript processing errors
   */
  private handleTranscriptError(streamId: string, error: Error) {
    this.logger.error(`Transcript error for stream ${streamId}:`, error);
    this.server.to(`stream-${streamId}`).emit('streamError', {
      streamId,
      error: 'Transcript processing error',
      details: error.message,
    });
  }

  /**
   * Cleans up a stream and its resources
   */
  private cleanupStream(streamId: string) {
    this.audioChunkingService.closeStream(streamId);
    this.transcriptStreamService.closeStream(streamId);
  }
}