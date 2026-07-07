import { z } from 'zod';

import type { BrowserActivity } from './entities/BrowserActivityEntity';

// Validation schema for creating browser activity
export const createBrowserActivitySchemaRoot = z.object({
  time: z.string().datetime(),
  device_id: z.string().uuid().optional(),
  // Any non-empty identity, not just http(s) URLs (#1673): search rows arrive
  // as bare queries or `search:<query>` synthetics from importers, and the
  // column is a plain-text identity nothing downstream dereferences — strict
  // .url() mass-rejected those rows at the /v1 bulk plane.
  url: z.string().min(1),
  title: z.string().optional(),
  action_type: z.enum(['visit', 'reload', 'bookmark', 'search', 'download', 'form_submit']).optional(),
  properties: z.record(z.unknown()).optional(),
  duration_seconds: z.number().int().min(0).optional(),
  scroll_depth_percent: z.number().min(0).max(100).optional(),
  page_summary: z.string().optional(),
  category: z.string().optional(),
  productivity_score: z.number().min(0).max(1).optional(),
  is_incognito: z.boolean().optional(),
  contains_sensitive: z.boolean().optional(),
  // Provenance triple for idempotent re-ingest (see browser_activity_source_triple_uniq).
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
});

export const createBrowserActivitySchema = z.union([
  createBrowserActivitySchemaRoot,
  z.array(createBrowserActivitySchemaRoot),
]);

export const updateBrowserActivitySchema = createBrowserActivitySchemaRoot.partial();

// DTOs
export interface CreateBrowserActivityDto {
  id?: string;
  time: string;
  device_id?: string;
  url: string;
  title?: string;
  action_type?: 'visit' | 'reload' | 'bookmark' | 'search' | 'download' | 'form_submit';
  properties?: Record<string, unknown>;
  duration_seconds?: number;
  scroll_depth_percent?: number;
  page_summary?: string;
  category?: string;
  productivity_score?: number;
  is_incognito?: boolean;
  contains_sensitive?: boolean;
  // Provenance triple for idempotent re-ingest (see browser_activity_source_triple_uniq).
  source_type?: string;
  source_system?: string;
  source_id?: string;
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
  category?: string;
  productivity_score?: number;
  is_incognito?: boolean;
  contains_sensitive?: boolean;
}

// Export the main type
export type { BrowserActivity };
