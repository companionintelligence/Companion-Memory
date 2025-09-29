import { useState, useEffect, useCallback } from 'react';

// Types for MCP API responses
export interface McpServer {
  name: string;
  enabled: boolean;
  description?: string;
  status?: 'running' | 'stopped' | 'error';
}

export interface McpSession {
  id: string;
  serverName: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  startTime?: string;
  tools?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  serverName: string;
  schema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpHealthStatus {
  serverName: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  lastCheck: Date;
  consecutiveFailures: number;
  uptime: number;
  responseTime?: number;
  error?: string;
}

// API base URL - dynamically determine based on environment
const getApiBase = () => {
  // If running on dev.companionintelligence.com, use the production API
  if (window.location.hostname === 'dev.companionintelligence.com') {
    return 'https://dev.companionintelligence.com'; // Adjust this to your actual backend URL
  }

  // For local development
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3030';
  }

  // Default fallback - use same origin
  return window.location.origin;
};

const API_BASE = getApiBase();

class McpApiService {
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        // Add auth headers if needed
        ...options?.headers,
      },
      ...options,
    });

    if (!response.ok) {
      throw new Error(`MCP API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getServers(): Promise<McpServer[]> {
    return this.request<McpServer[]>('/mcp/servers');
  }

  async getSessions(): Promise<McpSession[]> {
    return this.request<McpSession[]>('/mcp/sessions');
  }

  async getTools(): Promise<McpTool[]> {
    return this.request<McpTool[]>('/mcp/tools');
  }

  async getHealth(): Promise<McpHealthStatus[]> {
    return this.request<McpHealthStatus[]>('/mcp/health');
  }

  async startServer(serverName: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/mcp/servers/${serverName}/start`, {
      method: 'POST',
    });
  }

  async stopServer(serverName: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/mcp/servers/${serverName}/stop`, {
      method: 'POST',
    });
  }

  async executeTool(toolName: string, args: unknown): Promise<unknown> {
    return this.request('/mcp/execute', {
      method: 'POST',
      body: JSON.stringify({
        toolName,
        arguments: args,
      }),
    });
  }
}

const mcpApi = new McpApiService();

export function useMcpService() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [sessions, setSessions] = useState<McpSession[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [health, setHealth] = useState<McpHealthStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [serversData, sessionsData, toolsData, healthData] = await Promise.allSettled([
        mcpApi.getServers(),
        mcpApi.getSessions(),
        mcpApi.getTools(),
        mcpApi.getHealth(),
      ]);

      if (serversData.status === 'fulfilled') {
        setServers(serversData.value);
      }

      if (sessionsData.status === 'fulfilled') {
        setSessions(sessionsData.value);
      }

      if (toolsData.status === 'fulfilled') {
        setTools(toolsData.value);
      }

      if (healthData.status === 'fulfilled') {
        setHealth(healthData.value);
      }

      // Check if any critical errors occurred
      const errors = [serversData, sessionsData, toolsData, healthData]
        .filter((result) => result.status === 'rejected')
        .map((result) => (result as PromiseRejectedResult).reason.message);

      if (errors.length > 0) {
        setError(`Some data failed to load: ${errors.join(', ')}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const startServer = useCallback(
    async (serverName: string) => {
      try {
        await mcpApi.startServer(serverName);
        // Refresh data after starting server
        await refreshData();

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to start server',
        };
      }
    },
    [refreshData],
  );

  const stopServer = useCallback(
    async (serverName: string) => {
      try {
        await mcpApi.stopServer(serverName);
        // Refresh data after stopping server
        await refreshData();

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to stop server',
        };
      }
    },
    [refreshData],
  );

  const executeTool = useCallback(async (toolName: string, args: unknown = {}) => {
    try {
      const result = await mcpApi.executeTool(toolName, args);

      return { success: true, result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to execute tool',
      };
    }
  }, []);

  // Load data on mount
  useEffect(() => {
    refreshData();
  }, [refreshData]);

  // Get server status by merging servers, sessions, and health data
  const getServerStatus = useCallback(
    (serverName: string) => {
      const server = servers.find((s) => s.name === serverName);
      const session = sessions.find((s) => s.serverName === serverName);
      const healthStatus = health.find((h) => h.serverName === serverName);

      return {
        enabled: server?.enabled ?? false,
        status: session?.status ?? 'disconnected',
        health: healthStatus?.status ?? 'unknown',
        uptime: healthStatus?.uptime ?? 0,
        lastError: healthStatus?.error,
      };
    },
    [servers, sessions, health],
  );

  // Group tools by server
  const toolsByServer = useCallback(() => {
    const grouped: Record<string, McpTool[]> = {};

    tools.forEach((tool) => {
      if (!grouped[tool.serverName]) {
        grouped[tool.serverName] = [];
      }

      grouped[tool.serverName].push(tool);
    });

    return grouped;
  }, [tools]);

  return {
    servers,
    sessions,
    tools,
    health,
    isLoading,
    error,
    refreshData,
    startServer,
    stopServer,
    executeTool,
    getServerStatus,
    toolsByServer: toolsByServer(),
  };
}
