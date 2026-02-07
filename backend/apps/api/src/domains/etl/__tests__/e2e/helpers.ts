/**
 * E2E Test Helper Functions
 * 
 * Utility functions for creating test data, validating results, and common assertions
 */

import type { Connection } from '@ci/domains/connections';
import type { RequestContext } from '@ci/common/context';
import type { SourceSyncResult, ConnectionSyncResult } from '../../types/sync';
import { REQUIRED_FIELDS } from './test-config';

/**
 * Create a mock connection for testing
 */
export function createMockConnection(
  providerId: string,
  overrides: Partial<Connection> = {},
): Connection {
  return {
    id: `conn-${providerId}-${Date.now()}`,
    userId: 'test-user-id',
    providerId,
    providerName: providerId.charAt(0).toUpperCase() + providerId.slice(1),
    accessToken: `mock-token-${providerId}`,
    refreshToken: `mock-refresh-${providerId}`,
    expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
    syncState: {},
    activeEndpoints: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Connection;
}

/**
 * Create a mock request context
 */
export function createMockContext(userId = 'test-user-id'): RequestContext {
  return {
    userId,
    sessionId: 'test-session-id',
    requestId: `req-${Date.now()}`,
  } as RequestContext;
}

/**
 * Validate connection sync result structure
 */
export function validateSyncResult(result: ConnectionSyncResult): void {
  expect(result).toBeDefined();
  expect(result.connectionId).toBeDefined();
  expect(result.success).toBeDefined();
  expect(Array.isArray(result.sources)).toBe(true);
  expect(typeof result.totalRecords).toBe('number');
  expect(result.startedAt).toBeInstanceOf(Date);
  expect(result.completedAt).toBeInstanceOf(Date);
  expect(typeof result.duration).toBe('number');
}

/**
 * Validate source sync result structure
 */
export function validateSourceResult(result: SourceSyncResult): void {
  expect(result).toBeDefined();
  expect(result.source).toBeDefined();
  expect(typeof result.records).toBe('number');
  expect(typeof result.success).toBe('boolean');
  
  if (!result.success) {
    expect(result.error).toBeDefined();
  }
}

/**
 * Validate transformed data structure
 */
export function validateTransformedData(
  data: unknown[],
  expectedType: keyof typeof REQUIRED_FIELDS,
): void {
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThan(0);

  const requiredFields = REQUIRED_FIELDS[expectedType];
  
  for (const item of data) {
    expect(typeof item).toBe('object');
    expect(item).not.toBeNull();
    
    // Check all required fields are present
    for (const field of requiredFields) {
      expect(item).toHaveProperty(field);
      expect((item as any)[field]).toBeDefined();
    }
    
    // Validate common field types
    const record = item as any;
    expect(typeof record.externalId).toBe('string');
    expect(typeof record.type).toBe('string');
    expect(typeof record.platform).toBe('string');
    
    if (record.timestamp) {
      expect(record.timestamp).toBeInstanceOf(Date);
    }
  }
}

/**
 * Validate pagination behavior
 */
export function validatePagination(
  firstBatch: unknown[],
  secondBatch: unknown[],
  pageSize: number,
): void {
  // First batch should be at or below page size
  expect(firstBatch.length).toBeLessThanOrEqual(pageSize);
  
  // If we got a full page, second batch should have data
  if (firstBatch.length === pageSize) {
    expect(secondBatch.length).toBeGreaterThan(0);
  }
  
  // No duplicate IDs between batches
  const firstIds = new Set(firstBatch.map((item: any) => item.externalId));
  const secondIds = new Set(secondBatch.map((item: any) => item.externalId));
  
  for (const id of secondIds) {
    expect(firstIds.has(id)).toBe(false);
  }
}

/**
 * Validate rate limiting is applied
 */
export function validateRateLimiting(
  startTime: number,
  endTime: number,
  requestCount: number,
  maxRequestsPerSecond: number,
): void {
  const duration = (endTime - startTime) / 1000; // Convert to seconds
  const actualRate = requestCount / duration;
  
  // Should not exceed rate limit (with small tolerance)
  expect(actualRate).toBeLessThanOrEqual(maxRequestsPerSecond * 1.1);
}

/**
 * Validate error handling
 */
export function validateErrorHandling(error: unknown): void {
  expect(error).toBeDefined();
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBeDefined();
  expect((error as Error).message.length).toBeGreaterThan(0);
}

/**
 * Wait for a specified duration (for testing async operations)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an operation with exponential backoff
 */
export async function retry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }
  throw new Error('Retry failed');
}

/**
 * Assert data matches expected schema
 */
export function assertSchemaMatch(
  data: any,
  schema: Record<string, string>,
): void {
  for (const [field, expectedType] of Object.entries(schema)) {
    expect(data).toHaveProperty(field);
    expect(typeof data[field]).toBe(expectedType);
  }
}
