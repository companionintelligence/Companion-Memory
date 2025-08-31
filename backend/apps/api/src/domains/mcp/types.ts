/**
 * MCP (Model Context Protocol) related types
 */

/**
 * MCP Tool Definition
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * MCP Tool Call Request
 */
export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * MCP Tool Execution Result
 */
export interface McpToolResult {
  success: boolean;
  content?: unknown;
  error?: string;
  executionTimeMs?: number;
}

/**
 * MCP Call Request for queueing
 */
export interface McpCallRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  userId: string;
  requestId?: string;
}

/**
 * MCP Call Response
 */
export interface McpCallResponse {
  success: boolean;
  result?: McpToolResult;
  error?: string;
  requestId?: string;
}
