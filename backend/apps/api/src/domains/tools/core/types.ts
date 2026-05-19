/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';

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
  minimum?: number;
  maximum?: number;
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
  /**
   * Scopes (plan 07) a caller must hold to invoke this tool when accessed
   * over MCP / API-key paths. Session JWT (the human owner) is never
   * checked. Omit or empty to leave the tool ungated.
   */
  requiredScopes?: string[];
  /**
   * Whether the tool requires explicit user confirmation before each
   * invocation (plan 06). The MCP layer responds with a one-shot token the
   * caller must echo back to actually execute. Defaults to false.
   */
  requiresConfirmation?: boolean;
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
