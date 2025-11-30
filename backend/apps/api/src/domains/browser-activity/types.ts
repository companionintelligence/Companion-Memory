import { z } from 'zod';

import type { BrowserActivity } from './entities/BrowserActivityEntity';

// Validation schema for creating browser activity
export const createBrowserActivitySchemaRoot = z.object({
  time: z.string().datetime(),
  device_id: z.string().uuid(),
  url: z.string().url(),
  title: z.string().optional(),
  action_type: z.enum(['visit', 'reload', 'bookmark', 'search', 'download', 'form_submit']).optional(),
  properties: z.record(z.unknown()).optional(),
  duration_seconds: z.number().int().min(0).optional(),
  scroll_depth_percent: z.number().min(0).max(100).optional(),
  page_summary: z.string().optional(),
  page_embedding: z.array(z.number()).optional(),
  category: z.string().optional(),
  productivity_score: z.number().min(0).max(1).optional(),
  is_incognito: z.boolean().optional(),
  contains_sensitive: z.boolean().optional(),
});

export const createBrowserActivitySchema = z.union([
  createBrowserActivitySchemaRoot,
  z.array(createBrowserActivitySchemaRoot),
]);

export const updateBrowserActivitySchema = createBrowserActivitySchemaRoot.partial();

// DTOs
export interface CreateBrowserActivityDto {
  time: string;
  device_id: string;
  url: string;
  title?: string;
  action_type?: 'visit' | 'reload' | 'bookmark' | 'search' | 'download' | 'form_submit';
  properties?: Record<string, unknown>;
  duration_seconds?: number;
  scroll_depth_percent?: number;
  page_summary?: string;
  page_embedding?: number[];
  category?: string;
  productivity_score?: number;
  is_incognito?: boolean;
  contains_sensitive?: boolean;
}

export interface UpdateBrowserActivityDto {
  time?: string;
  device_id?: string;
  url?: string;
  title?: string;
  action_type?: 'visit' | 'reload' | 'bookmark' | 'search' | 'download' | 'form_submit';
  properties?: Record<string, unknown>;
  duration_seconds?: number;
  scroll_depth_percent?: number;
  page_summary?: string;
  page_embedding?: number[];
  category?: string;
  productivity_score?: number;
  is_incognito?: boolean;
  contains_sensitive?: boolean;
}

// Export the main type
export type { BrowserActivity };
