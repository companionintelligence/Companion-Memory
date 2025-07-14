import type { User } from '@ci/domains/user';

export interface PromptInput {
  prompt: string;
  model?: string;
  threadId?: string;
}

export interface MediaAnalysisInput {
  model?: string;
  analysisType: 'people' | 'places' | 'objects' | 'comprehensive';
  includeMetadata?: boolean;
  threadId?: string;
  fileId?: string;
}

export interface CreateMessageDto {
  threadId: string;
  model: string;
  prompt: boolean;
  text?: string;
  mimetype?: string;
  canceled?: boolean;
  promptMessageId?: string;
}

export interface UpdateMessageDto {
  text?: string;
  canceled?: boolean;
}

export interface CreateThreadDto {
  name?: string;
  model?: string;
  description?: string;
}

export interface UpdateThreadDto {
  name?: string;
  description?: string;
}

export interface Message {
  readonly id: string;
  readonly model: string | null;
  readonly text: string | null;
  readonly mimetype: string | null;
  readonly prompt: boolean | null;
  readonly canceled: boolean | null;
  readonly user?: User;
  readonly thread?: Thread;
  readonly promptMessage?: Message | null;
}

export interface Thread {
  readonly id: string;
  readonly name: string | null;
  readonly model: string | null;
  readonly description: string | null;
  readonly user?: User;
}

export interface OllamaModel {
  model: string;
  namespace: string | null;
  name: string;
  tag: string | null;
}

// Media Analysis Types

export interface MediaEntity {
  type: 'person' | 'place' | 'object';
  name: string;
  confidence: number;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  attributes?: Record<string, any>;
}

export interface MediaAnalysisResult {
  id: string;
  filename?: string;
  url?: string;
  mimetype: string;
  analysisType: string;
  model: string;
  analysis: {
    people?: MediaEntity[];
    places?: MediaEntity[];
    objects?: MediaEntity[];
    summary?: string;
    metadata?: {
      resolution?: { width: number; height: number };
      duration?: number;
      fileSize?: number;
      format?: string;
      [key: string]: any;
    };
  };
  processedAt: string;
  processingTimeMs: number;
}
