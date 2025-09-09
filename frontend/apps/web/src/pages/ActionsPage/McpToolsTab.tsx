import { Badge, Button, Card } from '@ci/shadcn';
import {
  Activity,
  AlertCircle,
  CheckCircle,
  Clock,
  Play,
  Server,
  Settings,
  Square,
  Wrench,
  Zap,
} from '@ci/shadcn/icons';

import { useMcpService, type McpTool } from '@/api';

interface McpServerCardProps {
  serverName: string;
  tools: McpTool[];
  onStartServer: (serverName: string) => Promise<{ success: boolean; error?: string }>;
  onStopServer: (serverName: string) => Promise<{ success: boolean; error?: string }>;
  onExecuteTool: (
    toolName: string,
    args?: unknown,
  ) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  getServerStatus: (serverName: string) => {
    enabled: boolean;
    status: string;
    health: string;
    uptime: number;
    lastError?: string;
  };
}

const McpServerCard = ({
  serverName,
  tools,
  onStartServer,
  onStopServer,
  onExecuteTool,
  getServerStatus,
}: McpServerCardProps) => {
  const serverStatus = getServerStatus(serverName);
  const isRunning = serverStatus.status === 'connected';
  const isHealthy = serverStatus.health === 'healthy';

  const getStatusIcon = () => {
    if (isRunning && isHealthy) {
      return <CheckCircle className="h-4 w-4 text-green-600" />;
    }

    if (isRunning && !isHealthy) {
      return <AlertCircle className="h-4 w-4 text-yellow-600" />;
    }

    return <AlertCircle className="h-4 w-4 text-red-600" />;
  };

  const getStatusText = () => {
    if (isRunning && isHealthy) {
      return 'Running';
    }

    if (isRunning && !isHealthy) {
      return 'Running (Unhealthy)';
    }

    return 'Stopped';
  };

  const getStatusColor = () => {
    if (isRunning && isHealthy) {
      return 'bg-green-100 text-green-700';
    }

    if (isRunning && !isHealthy) {
      return 'bg-yellow-100 text-yellow-700';
    }

    return 'bg-red-100 text-red-700';
  };

  const handleServerToggle = async () => {
    if (isRunning) {
      await onStopServer(serverName);
    } else {
      await onStartServer(serverName);
    }
  };

  const handleToolExecution = async (toolName: string) => {
    // For demo purposes, just show it works
    await onExecuteTool(toolName, {});
  };

  return (
    <Card className="h-full">
      <Card.Header className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Server className="h-6 w-6" />
            </div>
            <div>
              <Card.Title className="text-lg">{serverName}</Card.Title>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="secondary" className="text-xs">
                  {tools.length} tools
                </Badge>
                <span
                  className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 ${getStatusColor()}`}
                >
                  {getStatusIcon()}
                  {getStatusText()}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <Button
              size="sm"
              variant={isRunning ? 'destructive' : 'default'}
              onClick={handleServerToggle}
              className="min-w-[80px]"
            >
              {isRunning ? (
                <>
                  <Square className="h-4 w-4 mr-1" />
                  Stop
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-1" />
                  Start
                </>
              )}
            </Button>

            {serverStatus.uptime > 0 && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {Math.floor(serverStatus.uptime / 1000)}s uptime
              </div>
            )}
          </div>
        </div>
      </Card.Header>

      <Card.Content className="space-y-4">
        {serverStatus.lastError && (
          <div className="text-xs text-red-600 bg-red-50 p-2 rounded-md flex items-start gap-2">
            <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
            <span>{serverStatus.lastError}</span>
          </div>
        )}

        <div>
          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Available Tools:
          </h4>

          {tools.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No tools available</p>
          ) : (
            <div className="space-y-2">
              {tools.map((tool, index) => (
                <div key={index} className="flex items-center justify-between p-2 bg-muted/30 rounded-md">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-muted-foreground truncate">{tool.description}</div>
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleToolExecution(tool.name)}
                    disabled={!isRunning}
                    className="ml-2 h-6 px-2"
                  >
                    <Zap className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {!serverStatus.enabled && (
          <div className="text-xs text-orange-600 bg-orange-50 p-2 rounded-md flex items-start gap-2">
            <Settings className="h-3 w-3 mt-0.5 flex-shrink-0" />
            <span>This server is disabled in configuration</span>
          </div>
        )}
      </Card.Content>
    </Card>
  );
};

export function McpToolsTab() {
  const {
    toolsByServer,
    isLoading,
    error,
    refreshData,
    startServer,
    stopServer,
    executeTool,
    getServerStatus,
  } = useMcpService();

  // Check if we're in demo mode by looking for demo indicators
  const isDemoMode = error && error.includes('unavailable');

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <Activity className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">Loading MCP servers and tools...</p>
      </div>
    );
  }

  if (error && !isDemoMode) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <div className="text-center">
          <p className="text-destructive font-medium">Failed to load MCP data</p>
          <p className="text-sm text-muted-foreground mt-1">{error}</p>
          <Button onClick={refreshData} variant="outline" className="mt-4">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const serverNames = Object.keys(toolsByServer);

  if (serverNames.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <Server className="h-8 w-8 text-muted-foreground" />
        <div className="text-center">
          <p className="font-medium">No MCP servers found</p>
          <p className="text-sm text-muted-foreground mt-1">
            Configure MCP servers in your backend to see tools here
          </p>
          <Button onClick={refreshData} variant="outline" className="mt-4">
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Demo Mode Banner */}
      {isDemoMode && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-amber-800">Demo Mode Active</h3>
              <p className="text-sm text-amber-700 mt-1">
                MCP backend is not available. Showing sample data for demonstration purposes. Server controls
                will simulate actions but won't affect real services.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">MCP Server Tools</h2>
          <p className="text-sm text-muted-foreground">
            External tools provided by Model Context Protocol servers
          </p>
        </div>
        <Button onClick={refreshData} variant="outline" size="sm">
          <Activity className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Stats Section */}
      <div className="flex gap-4 text-sm">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-green-500 rounded-full"></div>
          <span>
            {Object.values(toolsByServer).reduce((total, tools) => total + tools.length, 0)} Total Tools
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
          <span>{serverNames.length} Active Servers</span>
        </div>
      </div>

      {/* Servers Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {serverNames.map((serverName) => (
          <McpServerCard
            key={serverName}
            serverName={serverName}
            tools={toolsByServer[serverName]}
            onStartServer={startServer}
            onStopServer={stopServer}
            onExecuteTool={executeTool}
            getServerStatus={getServerStatus}
          />
        ))}
      </div>

      {/* Help Text */}
      <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
        <h3 className="text-sm font-medium text-blue-900 mb-2">About MCP Server Tools</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>
            • <strong>MCP Servers</strong> provide external capabilities to the AI assistant
          </li>
          <li>
            • <strong>Start/Stop</strong> servers to control which tools are available
          </li>
          <li>
            • <strong>Health indicators</strong> show the current status of each server
          </li>
          <li>
            • <strong>Tool execution</strong> allows you to test individual tools (demo mode)
          </li>
        </ul>
      </div>
    </div>
  );
}
