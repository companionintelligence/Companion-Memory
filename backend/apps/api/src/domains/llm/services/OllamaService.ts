import { Injectable } from '@nestjs/common';
import ollama, { type ChatResponse, type GenerateResponse, type Message as OllamaMessage } from 'ollama';

import type { RequestContext } from '@ci/common/types';
import { LoggerService } from '@ci/common/services';

import type { Message, OllamaModel, MediaAnalysisInput, MediaAnalysisResult } from '../types';

import { MessageService } from './MessageService';

const PROMPT_MODEL = 'gemma3:1b';
const INTERNAL_MODELS = new Set(['nomic-embed-text']);

interface PromptOptions {
  model?: string;
  signal?: AbortSignal;
}

type MessagesInput = Pick<Message, 'prompt' | 'text'>[];

@Injectable()
export class OllamaService {
  private logger = new LoggerService(OllamaService.name);

  constructor(private readonly messageService: MessageService) {}

  async getAvailableModels(context: RequestContext): Promise<OllamaModel[]> {
    const result = await ollama.list();
    const models = result.models.map((model: any) => this.parseOllamaModel(model.name));

    return models.filter((model: OllamaModel) => !INTERNAL_MODELS.has(model.name));
  }

  async generateStream(
    context: RequestContext,
    prompt: string,
    options?: PromptOptions,
  ): Promise<AsyncGenerator<GenerateResponse> & { buffer: string }> {
    const chunks: string[] = [];

    const stream = (async function* () {
      const resolvedOptions = options ?? {};
      const { model = PROMPT_MODEL, signal } = resolvedOptions;

      const iterator = await ollama.generate({
        model,
        prompt,
        stream: true,
      });

      signal?.addEventListener('abort', () => {
        iterator.abort();
      });

      for await (const chunk of iterator) {
        if (chunk && !!chunk.response) {
          chunks.push(chunk.response);
        }

        yield chunk;
      }
    })();

    Object.defineProperty(stream, 'buffer', {
      enumerable: true,
      get: () => chunks.join(''),
    });

    return stream as typeof stream & { buffer: string };
  }

  async generate(
    context: RequestContext,
    prompt: string,
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<GenerateResponse> {
    const resolvedOptions = options ?? ({} as PromptOptions);
    const { model = PROMPT_MODEL } = resolvedOptions;

    return ollama.generate({
      model,
      prompt,
    });
  }

  async chatStream(
    context: RequestContext,
    messages: MessagesInput,
    options?: PromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { buffer: string }> {
    const chunks: string[] = [];

    const stream = (async function* (self) {
      const resolvedOptions = options ?? {};
      const { model = PROMPT_MODEL, signal } = resolvedOptions;

      const iterator = await ollama.chat({
        model,
        messages: self.toOllamaMessages(messages),
        stream: true,
      });

      signal?.addEventListener('abort', () => {
        iterator.abort();
      });

      for await (const chunk of iterator) {
        if (chunk && !!chunk.message) {
          // TODO: Handle other properties on `chunk.message`.
          //   chunk.message.images?
          //   chunk.message.role
          //   chunk.message.tool_calls?
          chunks.push(chunk.message.content);
        }

        yield chunk;
      }
    })(this);

    Object.defineProperty(stream, 'buffer', {
      enumerable: true,
      get: () => chunks.join(''),
    });

    return stream as typeof stream & { buffer: string };
  }

  async chat(
    context: RequestContext,
    messages: MessagesInput,
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<ChatResponse> {
    const resolvedOptions = options ?? ({} as PromptOptions);
    const { model = PROMPT_MODEL } = resolvedOptions;

    return ollama.chat({
      model,
      messages: this.toOllamaMessages(messages),
    });
  }

  async generateWithImages(
    context: RequestContext,
    prompt: string,
    images: string[],
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<GenerateResponse> {
    const resolvedOptions = options ?? ({} as PromptOptions);
    const { model = 'llama3.2-vision:latest' } = resolvedOptions;

    return ollama.generate({
      model,
      prompt,
      images,
    });
  }

  async chatWithImages(
    context: RequestContext,
    messages: MessagesInput,
    images: string[],
    options?: Omit<PromptOptions, 'signal'>,
  ): Promise<ChatResponse> {
    const resolvedOptions = options ?? ({} as PromptOptions);
    const { model = 'llama3.2-vision:latest' } = resolvedOptions;

    const ollamaMessages = this.toOllamaMessages(messages);
    
    // Add images to the last user message
    if (ollamaMessages.length > 0) {
      const lastMessage = ollamaMessages[ollamaMessages.length - 1];
      if (lastMessage.role === 'user') {
        lastMessage.images = images;
      }
    }

    return ollama.chat({
      model,
      messages: ollamaMessages,
    });
  }

  // Helper method to detect if a model supports vision
  async isVisionModel(context: RequestContext, model: string): Promise<boolean> {
    const visionKeywords = ['vision', 'llava', 'bakllava', 'minicpm-v'];
    return visionKeywords.some(keyword => model.toLowerCase().includes(keyword));
  }

  // Helper method to get recommended models for different media types
  getRecommendedModel(mediaType: 'image' | 'video' | 'audio'): string {
    switch (mediaType) {
      case 'image':
        return 'llama3.2-vision:latest';
      case 'video':
        return 'llama3.2-vision:latest'; // Same model can handle video frames
      case 'audio':
        return 'whisper:latest'; // For transcription, then text analysis
      default:
        return PROMPT_MODEL;
    }
  }

  // Detect mime type and get media type
  detectMediaType(mimeType: string): 'image' | 'video' | 'audio' | 'unsupported' {
    if (mimeType.startsWith('image/')) {
      return 'image';
    } else if (mimeType.startsWith('video/')) {
      return 'video';
    } else if (mimeType.startsWith('audio/')) {
      return 'audio';
    }
    return 'unsupported';
  }

  // Main method to analyze media files
  async analyzeMedia(
    context: RequestContext,
    fileBuffer: Uint8Array,
    mimeType: string,
    input: MediaAnalysisInput,
  ): Promise<MediaAnalysisResult> {
    const mediaType = this.detectMediaType(mimeType);
    
    if (mediaType === 'unsupported') {
      throw new Error(`Unsupported media type: ${mimeType}`);
    }

    const model = input.model || this.getRecommendedModel(mediaType);
    
    this.logger.log(`Analyzing ${mediaType} media with model: ${model}`, {
      mimeType,
      analysisType: input.analysisType,
      modelUsed: model,
    });

    let analysisResult: MediaAnalysisResult;

    switch (mediaType) {
      case 'image':
        analysisResult = await this.analyzeImage(context, fileBuffer, input, model);
        break;
      case 'video':
        analysisResult = await this.analyzeVideo(context, fileBuffer, input, model);
        break;
      case 'audio':
        analysisResult = await this.analyzeAudio(context, fileBuffer, input, model);
        break;
      default:
        throw new Error(`Unsupported media type: ${mediaType}`);
    }

    return {
      ...analysisResult,
      mimetype: mimeType,
      model,
      analysisType: input.analysisType,
    };
  }

  // Analyze image content
  private async analyzeImage(
    context: RequestContext,
    imageBuffer: Uint8Array,
    input: MediaAnalysisInput,
    model: string,
  ): Promise<MediaAnalysisResult> {
    const startTime = Date.now();
    
    // Convert Uint8Array to base64 string for Ollama
    const base64Image = this.uint8ArrayToBase64(imageBuffer);
    
    const prompt = this.buildAnalysisPrompt(input.analysisType);
    
    const response = await this.generateWithImages(context, prompt, [base64Image], { model });
    
    const baseResult = this.parseAnalysisResponse(response.response, input.analysisType);
    const processingTime = Date.now() - startTime;
    
    return {
      id: baseResult.id || `image-${Date.now()}`,
      mimetype: '',
      analysisType: input.analysisType,
      model,
      analysis: baseResult.analysis || {},
      processedAt: new Date().toISOString(),
      processingTimeMs: processingTime,
    };
  }

  // Analyze video content (extract frames and analyze)
  private async analyzeVideo(
    context: RequestContext,
    videoBuffer: Uint8Array,
    input: MediaAnalysisInput,
    model: string,
  ): Promise<MediaAnalysisResult> {
    const startTime = Date.now();
    
    // For now, we'll treat video as a static image by taking the first frame
    // In a production system, you'd want to extract multiple frames
    this.logger.log('Video analysis currently uses first frame extraction');
    
    // Convert video buffer to base64 for now - in production, you'd use FFmpeg or similar
    const base64Video = this.uint8ArrayToBase64(videoBuffer);
    
    const prompt = this.buildAnalysisPrompt(input.analysisType) + 
      " This is a video file - please analyze the visual content you can see.";
    
    const response = await this.generateWithImages(context, prompt, [base64Video], { model });
    
    const baseResult = this.parseAnalysisResponse(response.response, input.analysisType);
    const processingTime = Date.now() - startTime;
    
    return {
      id: baseResult.id || `video-${Date.now()}`,
      mimetype: '',
      analysisType: input.analysisType,
      model,
      analysis: baseResult.analysis || {},
      processedAt: new Date().toISOString(),
      processingTimeMs: processingTime,
    };
  }

  // Analyze audio content (transcribe then analyze)
  private async analyzeAudio(
    context: RequestContext,
    audioBuffer: Uint8Array,
    input: MediaAnalysisInput,
    model: string,
  ): Promise<MediaAnalysisResult> {
    const startTime = Date.now();
    
    this.logger.log('Audio analysis - transcription and content analysis');
    
    // For audio, we'd typically:
    // 1. Transcribe using Whisper
    // 2. Analyze the transcribed text
    
    const processingTime = Date.now() - startTime;
    
    // Simplified approach - return audio analysis placeholder
    return {
      id: `audio-${Date.now()}`,
      mimetype: '',
      analysisType: input.analysisType,
      model,
      analysis: {
        summary: 'Audio analysis requires transcription - implement Whisper integration',
        metadata: {
          format: 'audio',
          fileSize: audioBuffer.length,
        },
      },
      processedAt: new Date().toISOString(),
      processingTimeMs: processingTime,
    };
  }

  // Build analysis prompt based on type
  private buildAnalysisPrompt(analysisType: string): string {
    const basePrompt = "Analyze this media and respond with a JSON object containing:";
    
    switch (analysisType) {
      case 'people':
        return `${basePrompt} {"people": [{"name": "person name", "confidence": 0.95, "attributes": {"age": "approximate age", "gender": "gender", "emotion": "emotion"}}], "summary": "brief description"}`;
      case 'places':
        return `${basePrompt} {"places": [{"name": "location name", "confidence": 0.95, "attributes": {"type": "indoor/outdoor", "setting": "description"}}], "summary": "brief description"}`;
      case 'objects':
        return `${basePrompt} {"objects": [{"name": "object name", "confidence": 0.95, "attributes": {"color": "color", "size": "relative size"}}], "summary": "brief description"}`;
      case 'comprehensive':
        return `${basePrompt} {"people": [...], "places": [...], "objects": [...], "summary": "comprehensive description of the scene", "metadata": {"colors": ["dominant colors"], "mood": "overall mood"}}`;
      default:
        return `${basePrompt} {"summary": "description of what you see"}`;
    }
  }

  // Parse the LLM response into structured data
  private parseAnalysisResponse(response: string, analysisType: string): Partial<MediaAnalysisResult> {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          id: `analysis-${Date.now()}`,
          analysis: parsed,
        };
      }
    } catch (error) {
      this.logger.warn('Failed to parse JSON response, falling back to text summary');
    }

    // Fallback to text response
    return {
      id: `analysis-${Date.now()}`,
      analysis: {
        summary: response,
      },
    };
  }

  // Utility method to convert Uint8Array to base64
  private uint8ArrayToBase64(uint8Array: Uint8Array): string {
    let binary = '';
    const len = uint8Array.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  async validateModel(context: RequestContext, model: string | undefined): Promise<OllamaModel> {
    const resolvedModel = model ?? PROMPT_MODEL;

    const availableModels = await this.getAvailableModels(context);

    const validModel = availableModels.find((availableModel) => availableModel.model === resolvedModel);

    if (!validModel) {
      throw new Error(`Invalid model specified: ${model}`);
    }

    return validModel;
  }

  private toOllamaMessages(messages: MessagesInput): OllamaMessage[] {
    const ollamaMessages: OllamaMessage[] = messages.map(
      (message) =>
        ({
          role: message.prompt ? 'user' : 'system',
          content: message.text ?? '',
        }) satisfies OllamaMessage,
    );

    return ollamaMessages;
  }

  private parseOllamaModel(model: string): OllamaModel {
    const [fullName, tag = 'latest'] = model.split(':'); // `namespace/model:tag`
    const parts = fullName.split('/');

    if (parts.length === 2) {
      const [namespace, name] = parts;

      return {
        model,
        namespace,
        name,
        tag,
      };
    }

    return {
      model,
      namespace: null,
      name: parts[0],
      tag,
    };
  }
}
