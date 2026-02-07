/**
 * Enhanced Sync Types
 * 
 * Extends existing sync types with new ETL system structures.
 */

import type { Connection } from '@ci/domains/connections';

/**
 * Sync response from a single endpoint
 */
export interface SyncResponse {
  /** Whether the sync was successful */
  success: boolean;
  
  /** Human-readable message */
  message: string;
  
  /** Sync data */
  data?: {
    /** Raw results from API */
    results: Array<{
      /** API endpoint name */
      api: string;
      
      /** Raw data from API */
      data: unknown;
      
      /** Sync state for this endpoint */
      syncState?: Record<string, unknown>;
    }>;
    
    /** Errors encountered */
    errors: string[];
  };
  
  /** Pagination cursor for next page */
  cursor?: Record<string, unknown>;
  
  /** Metadata about the sync */
  metadata?: {
    /** Number of items fetched */
    itemCount?: number;
    
    /** API calls made */
    apiCalls?: number;
    
    /** Time taken in milliseconds */
    duration?: number;
  };
}

/**
 * Result of syncing a single source
 */
export interface SourceSyncResult {
  /** Source name (e.g., "Gmail", "Calendar") */
  source: string;
  
  /** Number of records synced */
  records: number;
  
  /** Whether sync was successful */
  success: boolean;
  
  /** Error message if failed */
  error?: string;
  
  /** Updated sync state */
  syncState?: Record<string, unknown>;
}

/**
 * Result of syncing an entire connection
 */
export interface ConnectionSyncResult {
  /** Connection ID */
  connectionId: string;
  
  /** Whether overall sync was successful */
  success: boolean;
  
  /** Results per source */
  sources: SourceSyncResult[];
  
  /** Total records synced across all sources */
  totalRecords: number;
  
  /** Error message if failed */
  error?: string;
  
  /** Start time */
  startedAt: Date;
  
  /** End time */
  completedAt: Date;
  
  /** Duration in milliseconds */
  duration: number;
}

/**
 * Sync job status
 */
export type SyncJobStatus = 
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Sync job information
 */
export interface SyncJob {
  /** Job ID */
  id: string;
  
  /** Connection ID */
  connectionId: string;
  
  /** User ID */
  userId: string;
  
  /** Job status */
  status: SyncJobStatus;
  
  /** When job was created */
  createdAt: Date;
  
  /** When job started */
  startedAt?: Date;
  
  /** When job completed */
  completedAt?: Date;
  
  /** Job result */
  result?: ConnectionSyncResult;
  
  /** Error if failed */
  error?: string;
  
  /** Progress percentage (0-100) */
  progress?: number;
}

/**
 * Options for sync execution
 */
export interface SyncOptions {
  /** Whether to force a full sync (ignore cursors) */
  fullSync?: boolean;
  
  /** Specific sources to sync (if not all) */
  sources?: string[];
  
  /** Batch size for pagination */
  batchSize?: number;
  
  /** Whether to run in parallel */
  parallel?: boolean;
  
  /** Maximum concurrent requests */
  maxConcurrency?: number;
  
  /** Timeout in milliseconds */
  timeout?: number;
  
  /** Whether to continue on errors */
  continueOnError?: boolean;
}

/**
 * Rate limiter state
 */
export interface RateLimiterState {
  /** Tokens remaining */
  tokensRemaining: number;
  
  /** When tokens will be refilled */
  refillAt: Date;
  
  /** Requests made in current window */
  requestsInWindow: number;
  
  /** Window reset time */
  windowResetAt: Date;
}

/**
 * API request metadata
 */
export interface ApiRequestMetadata {
  /** Provider ID */
  providerId: string;
  
  /** Endpoint name */
  endpoint: string;
  
  /** HTTP method */
  method: string;
  
  /** Full URL */
  url: string;
  
  /** Request timestamp */
  timestamp: Date;
  
  /** Response status code */
  statusCode?: number;
  
  /** Response time in milliseconds */
  responseTime?: number;
  
  /** Whether request was successful */
  success: boolean;
  
  /** Error message if failed */
  error?: string;
}

// Re-export existing sync state types
export type {
  CalendarSyncState,
  GmailSyncState,
  DriveSyncState,
  ContactsSyncState,
  YouTubeSyncState,
  GoogleSyncState,
  OutlookMailSyncState,
  OutlookCalendarsSyncState,
  OutlookCalendarSyncState,
  OneDriveSyncState,
  FacebookSyncState,
  SyncResult,
  CalendarSyncResult,
  GmailSyncResult,
} from './syncTypes';
