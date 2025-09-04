import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
  enabled?: boolean;
  timeout?: number;
  description?: string;
}

export interface McpServersConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpSession {
  id: string;
  serverName: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  client?: Client; // Properly typed with SDK import
  processId?: number;
  lastError?: string;
  startedAt?: Date;
  tools?: string[];
}

export interface McpToolResult {
  success: boolean;
  content?: unknown;
  error?: string;
  executionTimeMs?: number;
}
