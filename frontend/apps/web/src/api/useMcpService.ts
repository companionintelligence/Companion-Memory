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

// Demo/mock data for when API is not available
const MOCK_SERVERS: McpServer[] = [
  {
    name: 'filesystem',
    enabled: true,
    description: 'File system operations and management',
    status: 'running',
  },
  {
    name: 'web-search',
    enabled: true,
    description: 'Multi-engine web search with content extraction',
    status: 'running',
  },
  {
    name: 'postgres',
    enabled: false,
    description: 'Direct PostgreSQL database access',
    status: 'stopped',
  },
];

const MOCK_SESSIONS: McpSession[] = [
  {
    id: 'sess_filesystem_001',
    serverName: 'filesystem',
    status: 'connected',
    startTime: new Date(Date.now() - 300000).toISOString(), // 5 minutes ago
    tools: ['read_file', 'write_file', 'list_directory'],
  },
  {
    id: 'sess_websearch_001',
    serverName: 'web-search',
    status: 'connected',
    startTime: new Date(Date.now() - 180000).toISOString(), // 3 minutes ago
    tools: ['web_search', 'scrape_url'],
  },
];

const MOCK_TOOLS: McpTool[] = [
  {
    name: 'read_file',
    description: 'Read contents of a file from the filesystem',
    serverName: 'filesystem',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Write content to a file on the filesystem',
    serverName: 'filesystem',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a given path',
    serverName: 'filesystem',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'web_search',
    description: 'Search the web using multiple search engines',
    serverName: 'web-search',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'scrape_url',
    description: 'Extract content from a web page URL',
    serverName: 'web-search',
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
];

const MOCK_HEALTH: McpHealthStatus[] = [
  {
    serverName: 'filesystem',
    status: 'healthy',
    lastCheck: new Date(),
    consecutiveFailures: 0,
    uptime: 300000, // 5 minutes
    responseTime: 45,
  },
  {
    serverName: 'web-search',
    status: 'healthy',
    lastCheck: new Date(),
    consecutiveFailures: 0,
    uptime: 180000, // 3 minutes
    responseTime: 120,
  },
  {
    serverName: 'postgres',
    status: 'unhealthy',
    lastCheck: new Date(),
    consecutiveFailures: 3,
    uptime: 0,
    error: 'Connection refused: database server not running',
  },
];

class McpApiService {
  private useMockData = false;

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    try {
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
    } catch (error) {
      // If this is the first failure, switch to mock data mode
      if (!this.useMockData) {
        console.warn('MCP API unavailable, switching to demo mode:', error);
        this.useMockData = true;
      }

      throw error;
    }
  }

  async getServers(): Promise<McpServer[]> {
    if (this.useMockData) {
      return Promise.resolve(MOCK_SERVERS);
    }

    try {
      return await this.request<McpServer[]>('/mcp/servers');
    } catch {
      this.useMockData = true;

      return MOCK_SERVERS;
    }
  }

  async getSessions(): Promise<McpSession[]> {
    if (this.useMockData) {
      return Promise.resolve(MOCK_SESSIONS);
    }

    try {
      return await this.request<McpSession[]>('/mcp/sessions');
    } catch {
      this.useMockData = true;

      return MOCK_SESSIONS;
    }
  }

  async getTools(): Promise<McpTool[]> {
    if (this.useMockData) {
      return Promise.resolve(MOCK_TOOLS);
    }

    try {
      return await this.request<McpTool[]>('/mcp/tools');
    } catch {
      this.useMockData = true;

      return MOCK_TOOLS;
    }
  }

  async getHealth(): Promise<McpHealthStatus[]> {
    if (this.useMockData) {
      return Promise.resolve(MOCK_HEALTH);
    }

    try {
      return await this.request<McpHealthStatus[]>('/mcp/health');
    } catch {
      this.useMockData = true;

      return MOCK_HEALTH;
    }
  }

  async startServer(serverName: string): Promise<{ success: boolean; message: string }> {
    if (this.useMockData) {
      // Simulate server start
      const server = MOCK_SERVERS.find((s) => s.name === serverName);
      if (server) {
        server.status = 'running';
        server.enabled = true;
      }

      return Promise.resolve({
        success: true,
        message: `Server ${serverName} started successfully (demo mode)`,
      });
    }

    return this.request(`/mcp/servers/${serverName}/start`, {
      method: 'POST',
    });
  }

  async stopServer(serverName: string): Promise<{ success: boolean; message: string }> {
    if (this.useMockData) {
      // Simulate server stop
      const server = MOCK_SERVERS.find((s) => s.name === serverName);
      if (server) {
        server.status = 'stopped';
      }

      return Promise.resolve({
        success: true,
        message: `Server ${serverName} stopped successfully (demo mode)`,
      });
    }

    return this.request(`/mcp/servers/${serverName}/stop`, {
      method: 'POST',
    });
  }

  async executeTool(toolName: string, args: unknown): Promise<unknown> {
    if (this.useMockData) {
      // Simulate tool execution
      return Promise.resolve({
        success: true,
        result: `Tool '${toolName}' executed successfully with args: ${JSON.stringify(args)} (demo mode)`,
        executionTime: Math.floor(Math.random() * 1000) + 100, // Random 100-1100ms
      });
    }

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
