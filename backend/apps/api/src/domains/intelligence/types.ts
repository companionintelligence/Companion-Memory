import { z } from 'zod';

export interface CreateActionDto {
  id?: string;
  title: string;
  text: string;
  imageUrl?: string;
  priority?: number;
  threadId: string;
  seen?: boolean;
  dismissed?: boolean;
}

export interface CreateAnswerDto {
  id?: string;
  text: string;
  question: {
    id: string;
  };
  answerConfidence?: number;
  answerSource?: string;
  answerMethod?: string;
  answeredAt?: Date;
  sessionContext?: Record<string, unknown>;
  emotionalState?: string;
  locationContext?: string;
  extractedEntities?: string[];
  sentimentScore?: number;
  complexityScore?: number;
  isSensitive?: boolean;
  sharingLevel?: string;
}

export interface UpdateAnswerDto {
  text?: string;
  answerConfidence?: number;
  answerSource?: string;
  answerMethod?: string;
  answeredAt?: Date;
  sessionContext?: Record<string, unknown>;
  emotionalState?: string;
  locationContext?: string;
  extractedEntities?: string[];
  sentimentScore?: number;
  complexityScore?: number;
  isSensitive?: boolean;
  sharingLevel?: string;
}

export interface CreateQuestionDto {
  id?: string;
  text: string;
  category?: string;
  isSeedQuestion?: boolean;
  isActive?: boolean;
  createdByLlm?: boolean;
  frequencyRecommendation?: string;
  isPrivateTo?: string | null;
}

export interface UpdateQuestionDto {
  subcategory?: string;
  text?: string;
  contextTags?: string[];
  questionType?: string;
  isSeedQuestion?: boolean;
  isActive?: boolean;
  createdByLlm?: boolean;
  frequencyRecommendation?: string;
  timesAsked?: number;
  timesAnswered?: number;
  isPrivateTo?: string;
}

export const createQuestionSchema = z.object({
  subcategory: z.string().optional(),
  text: z.string(),
});

export const updateQuestionSchema = z.object({
  subcategory: z.string().optional(),
  text: z.string(),
});

export const createAnswerSchema = z.object({
  text: z.string().min(1, 'Answer text is required').max(5000, 'Answer text must be 5000 characters or less'),
  question: z.object({
    id: z.string().uuid('Invalid question ID'),
  }),
});

export const updateAnswerSchema = z.object({
  text: z
    .string()
    .min(1, 'Answer text is required')
    .max(5000, 'Answer text must be 5000 characters or less')
    .optional(),
});
