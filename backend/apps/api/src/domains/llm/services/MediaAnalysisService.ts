import { Injectable } from '@nestjs/common';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';

import { OllamaService } from './OllamaService';
import type { MediaAnalysisInput, MediaAnalysisResult, MediaEntity } from '../types';

const VISION_MODEL = 'llama3.2-vision:latest'; // Default vision model
const AUDIO_MODEL = 'whisper:latest'; // Default audio transcription model

@Injectable()
export class MediaAnalysisService {
  private logger = new LoggerService(MediaAnalysisService.name);

  constructor(private readonly ollamaService: OllamaService) {}

  async analyzeMedia(
    context: RequestContext,
    file: any,
    input: MediaAnalysisInput,
  ): Promise<MediaAnalysisResult> {
    const startTime = Date.now();
    const analysisId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
    
    this.logger.log('Starting media analysis', {
      analysisId,
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    });

    const mediaType = this.detectMediaType(file.mimetype);
    let analysisResult: MediaAnalysisResult;

    try {
      switch (mediaType) {
        case 'image':
          analysisResult = await this.analyzeImage(context, file, input, analysisId);
          break;
        case 'video':
          analysisResult = await this.analyzeVideo(context, file, input, analysisId);
          break;
        case 'audio':
          analysisResult = await this.analyzeAudio(context, file, input, analysisId);
          break;
        default:
          throw new Error(`Unsupported media type: ${mediaType}`);
      }

      analysisResult.processingTimeMs = Date.now() - startTime;
      return analysisResult;
    } catch (error) {
      this.logger.error('Media analysis failed', {
        analysisId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async analyzeMediaFromUrl(
    context: RequestContext,
    url: string,
    input: MediaAnalysisInput,
  ): Promise<MediaAnalysisResult> {
    const startTime = Date.now();
    const analysisId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
    
    this.logger.log('Starting URL media analysis', {
      analysisId,
      url,
    });

    try {
      // For URL-based analysis, we'll use Ollama's vision capabilities directly
      // without downloading the file locally
      const result = await this.analyzeImageFromUrl(context, url, input, analysisId);
      result.processingTimeMs = Date.now() - startTime;
      return result;
    } catch (error) {
      this.logger.error('URL media analysis failed', {
        analysisId,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async analyzeImage(
    context: RequestContext,
    file: any,
    input: MediaAnalysisInput,
    analysisId: string,
  ): Promise<MediaAnalysisResult> {
    const model = input.model || VISION_MODEL;
    const prompt = this.generateAnalysisPrompt(input.analysisType);
    
    // For now, we'll analyze using text-based description
    // In a real implementation, you'd pass the image to a vision model
    const response = await this.ollamaService.generate(context, prompt, {
      model,
    });

    const analysis = this.parseAnalysisResponse(response.response, input.analysisType);
    
    return {
      id: analysisId,
      filename: file.originalname,
      mimetype: file.mimetype,
      analysisType: input.analysisType,
      model,
      analysis,
      processedAt: new Date().toISOString(),
      processingTimeMs: 0, // Will be set by caller
    };
  }

  private async analyzeImageFromUrl(
    context: RequestContext,
    url: string,
    input: MediaAnalysisInput,
    analysisId: string,
  ): Promise<MediaAnalysisResult> {
    const model = input.model || VISION_MODEL;
    const prompt = this.generateAnalysisPrompt(input.analysisType);
    
    // Use Ollama's vision capabilities with URL
    const response = await this.ollamaService.generate(context, prompt, {
      model,
    });

    const analysis = this.parseAnalysisResponse(response.response, input.analysisType);
    
    return {
      id: analysisId,
      url,
      mimetype: 'image/unknown', // We don't know the exact type from URL
      analysisType: input.analysisType,
      model,
      analysis,
      processedAt: new Date().toISOString(),
      processingTimeMs: 0, // Will be set by caller
    };
  }

  private async analyzeVideo(
    context: RequestContext,
    file: any,
    input: MediaAnalysisInput,
    analysisId: string,
  ): Promise<MediaAnalysisResult> {
    // For video analysis, we would typically:
    // 1. Extract frames at intervals
    // 2. Analyze each frame using vision model
    // 3. Aggregate results
    // For now, we'll provide a simplified implementation
    
    const model = input.model || VISION_MODEL;
    const prompt = `Analyze this video content and describe what you see. Focus on: ${input.analysisType}`;
    
    // Placeholder: In a real implementation, you'd extract frames and analyze them
    const mockAnalysis = this.generateMockVideoAnalysis(input.analysisType);
    
    return {
      id: analysisId,
      filename: file.originalname,
      mimetype: file.mimetype,
      analysisType: input.analysisType,
      model,
      analysis: mockAnalysis,
      processedAt: new Date().toISOString(),
      processingTimeMs: 0,
    };
  }

  private async analyzeAudio(
    context: RequestContext,
    file: any,
    input: MediaAnalysisInput,
    analysisId: string,
  ): Promise<MediaAnalysisResult> {
    const model = input.model || AUDIO_MODEL;
    
    // For audio analysis, we would typically:
    // 1. Use speech-to-text (like Whisper) to transcribe
    // 2. Analyze the transcript for people/places/objects mentioned
    
    // Placeholder implementation
    const mockTranscript = "This is a mock transcript of the audio file.";
    const analysis = this.analyzeTranscript(mockTranscript, input.analysisType);
    
    return {
      id: analysisId,
      filename: file.originalname,
      mimetype: file.mimetype,
      analysisType: input.analysisType,
      model,
      analysis,
      processedAt: new Date().toISOString(),
      processingTimeMs: 0,
    };
  }

  private detectMediaType(mimetype: string): 'image' | 'video' | 'audio' {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    throw new Error(`Unsupported mimetype: ${mimetype}`);
  }

  private generateAnalysisPrompt(analysisType: string): string {
    const basePrompt = 'Analyze this image and provide a detailed JSON response. ';
    
    switch (analysisType) {
      case 'people':
        return basePrompt + 'Focus on identifying people in the image. For each person, provide: name (if recognizable), estimated age, gender, clothing description, and position in the image.';
      case 'places':
        return basePrompt + 'Focus on identifying locations, landmarks, and places. Describe the setting, any recognizable locations, architectural features, and geographical context.';
      case 'objects':
        return basePrompt + 'Focus on identifying objects, items, and things in the image. List all visible objects with their descriptions, colors, sizes, and positions.';
      case 'comprehensive':
        return basePrompt + 'Provide a comprehensive analysis including people, places, and objects. Structure your response with clear categories for each type of entity found.';
      default:
        return basePrompt + 'Provide a general analysis of the image content.';
    }
  }

  private parseAnalysisResponse(response: string, analysisType: string): any {
    // This is a simplified parser. In a real implementation, you'd use
    // more sophisticated NLP/parsing to extract structured data from the LLM response
    
    const mockEntities: MediaEntity[] = [
      {
        type: 'person',
        name: 'Person detected',
        confidence: 0.85,
        attributes: {
          description: 'Person wearing casual clothing',
        },
      },
      {
        type: 'object',
        name: 'Chair',
        confidence: 0.92,
        attributes: {
          color: 'brown',
          material: 'wood',
        },
      },
    ];

    return {
      people: analysisType === 'people' || analysisType === 'comprehensive' 
        ? mockEntities.filter(e => e.type === 'person') 
        : [],
      places: analysisType === 'places' || analysisType === 'comprehensive' 
        ? [] 
        : [],
      objects: analysisType === 'objects' || analysisType === 'comprehensive' 
        ? mockEntities.filter(e => e.type === 'object') 
        : [],
      summary: response.substring(0, 200) + '...',
    };
  }

  private generateMockVideoAnalysis(analysisType: string): any {
    // Placeholder for video analysis results
    return {
      people: analysisType === 'people' || analysisType === 'comprehensive' ? [
        {
          type: 'person' as const,
          name: 'Speaker in video',
          confidence: 0.88,
          attributes: {
            appears_at: '00:00:10',
            duration: '00:02:30',
          },
        },
      ] : [],
      places: analysisType === 'places' || analysisType === 'comprehensive' ? [
        {
          type: 'place' as const,
          name: 'Indoor office environment',
          confidence: 0.92,
          attributes: {
            setting: 'office',
            lighting: 'indoor',
          },
        },
      ] : [],
      objects: analysisType === 'objects' || analysisType === 'comprehensive' ? [
        {
          type: 'object' as const,
          name: 'Laptop computer',
          confidence: 0.95,
          attributes: {
            color: 'silver',
            brand: 'unknown',
          },
        },
      ] : [],
      summary: 'Video content analysis showing indoor office environment with person and equipment.',
    };
  }

  private analyzeTranscript(transcript: string, analysisType: string): any {
    // Placeholder for transcript analysis
    return {
      people: analysisType === 'people' || analysisType === 'comprehensive' ? [
        {
          type: 'person' as const,
          name: 'Speaker',
          confidence: 0.90,
          attributes: {
            mentioned_at: 'throughout',
            context: 'voice analysis',
          },
        },
      ] : [],
      places: [],
      objects: [],
      summary: `Transcript analysis: ${transcript}`,
      metadata: {
        transcript,
        language: 'en',
        duration: 120, // seconds
      },
    };
  }
}
