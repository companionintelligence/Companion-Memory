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
  // Health monitoring settings
  healthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    retryCount?: number;
    restartOnFailure?: boolean;
  };
}

export interface McpServersConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpSession {
  id: string;
  serverName: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  client?: Client;
  processId?: number;
  lastError?: string;
  startedAt?: Date;
  tools?: string[];
  // Health monitoring data
  lastHealthCheck?: Date;
  healthCheckFailures?: number;
  isRestarting?: boolean;
}

export interface McpToolResult {
  success: boolean;
  content?: unknown;
  error?: string;
  executionTimeMs?: number;
}

export interface McpHealthStatus {
  serverName: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  lastCheck: Date;
  consecutiveFailures: number;
  uptime: number; // milliseconds
  responseTime?: number; // milliseconds
  error?: string;
}
