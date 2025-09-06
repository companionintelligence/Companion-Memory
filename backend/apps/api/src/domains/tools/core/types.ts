/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/types';

/**
 * JSON Schema definition for tool parameters
 */
export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: any[];
  description?: string;
}

/**
 * Example usage of a tool for documentation and testing
 */
export interface ToolExample {
  input: Record<string, any>;
  output: any;
  description: string;
}

/**
 * Schema definition for a tool - what the LLM sees
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
  examples?: ToolExample[];
  category?: string;
}

/**
 * Standardized error information for tools
 */
export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, any>;
}

/**
 * Result of tool execution
 */
export interface ToolResult<T = any> {
  success: boolean;
  data?: T;
  error?: ToolError;
  executionTimeMs?: number;
  metadata?: Record<string, any>;
}

/**
 * Execution context passed to tools with tracing info
 */
export interface ToolExecutionContext extends RequestContext {
  toolName: string;
  executionId: string;
  startTime: Date;
}
