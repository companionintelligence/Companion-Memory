import * as path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import type { McpServerConfig } from './types';

/**
 * Service responsible for creating and managing MCP client connections
 * Handles the low-level details of stdio transport and client lifecycle
 */
@Injectable()
export class McpClientManager {
  private readonly logger = new LoggerService(McpClientManager.name);

  /**
   * Create and connect to an MCP server
   */
  async createClient(serverName: string, config: McpServerConfig): Promise<Client> {
    // Resolve environment variables in working directory path
    let resolvedWorkingDirectory = config.workingDirectory;
    if (resolvedWorkingDirectory) {
      resolvedWorkingDirectory = this.resolveEnvironmentVariablesInPath(resolvedWorkingDirectory);
    }

    this.logger.debug(`Creating MCP client for ${serverName}`, {
      command: config.command,
      args: config.args,
      workingDirectory: resolvedWorkingDirectory,
      serverName,
    });

    // Resolve environment variables
    const resolvedEnv = this.resolveEnvironmentVariables(config.env || {});

    // Create transport using SDK
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: {
        ...(Object.fromEntries(
          Object.entries(process.env).filter(([, value]) => value !== undefined),
        ) as Record<string, string>),
        ...resolvedEnv,
      },
      ...(resolvedWorkingDirectory && { cwd: resolvedWorkingDirectory }),
    });

    // Set up error handling for the transport
    this.setupTransportErrorHandling(transport, serverName);

    // Create client using SDK
    const client = new Client(
      {
        name: 'ci-server',
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    this.logger.debug(`Attempting to connect to ${serverName}`, { serverName });

    // Connect to the server with timeout
    const connectTimeout = config.timeout || 30000;
    await this.connectWithTimeout(client, transport, connectTimeout);

    this.logger.debug(`Successfully connected to ${serverName}`, { serverName });

    return client;
  }

  /**
   * Gracefully close a client connection
   */
  async closeClient(client: Client, serverName: string): Promise<void> {
    try {
      await client.close();
      this.logger.debug(`Closed MCP client for ${serverName}`, { serverName });
    } catch (error) {
      this.logger.warn(`Error closing MCP client for ${serverName}`, {
        serverName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Test if a client connection is healthy
   */
  async testConnection(client: Client, timeoutMs: number = 5000): Promise<boolean> {
    try {
      const healthCheckPromise = client.listTools();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Health check timeout')), timeoutMs);
      });

      await Promise.race([healthCheckPromise, timeoutPromise]);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Connect client with timeout
   */
  private async connectWithTimeout(
    client: Client,
    transport: StdioClientTransport,
    timeoutMs: number,
  ): Promise<void> {
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Connection timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    await Promise.race([connectPromise, timeoutPromise]);
  }

  /**
   * Set up error handling for transport
   */
  private setupTransportErrorHandling(transport: StdioClientTransport, serverName: string): void {
    let stderrOutput = '';

    // Type guard for transport with internal properties
    const transportWithInternal = transport as unknown as {
      _transport?: {
        stderr?: NodeJS.ReadableStream;
        on?: (event: string, listener: (...args: unknown[]) => void) => void;
      };
    };

    if (transportWithInternal._transport?.stderr) {
      transportWithInternal._transport.stderr.on('data', (data: Buffer) => {
        const output = data.toString();
        stderrOutput += output;
        this.logger.debug(`Server ${serverName} stderr:`, { output });
      });
    }

    // Add close handler to capture why the server is closing
    if (transportWithInternal._transport?.on) {
      transportWithInternal._transport.on('close', (...args: unknown[]) => {
        const [code, signal] = args as [number, string];
        this.logger.error(`Server ${serverName} process closed`, {
          code,
          signal,
          stderr: stderrOutput || 'No stderr output',
          serverName,
        });
      });

      transportWithInternal._transport.on('error', (...args: unknown[]) => {
        const [error] = args as [Error];
        this.logger.error(`Server ${serverName} process error`, {
          error: error.message,
          stack: error.stack,
          stderr: stderrOutput || 'No stderr output',
          serverName,
        });
      });
    }
  }

  /**
   * Resolve environment variables in a path string
   */
  private resolveEnvironmentVariablesInPath(pathStr: string): string {
    // Resolve ${PROJECT_ROOT} to the project root directory
    // Go up from backend/apps/api to the project root
    const projectRoot = path.resolve(process.cwd(), '../../..');

    // Simple variable substitution: ${VAR_NAME}
    const resolvedPath = pathStr.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      if (varName === 'PROJECT_ROOT') {
        return projectRoot;
      }

      return process.env[varName] || '';
    });

    return resolvedPath;
  }

  /**
   * Resolve environment variables in config values
   */
  private resolveEnvironmentVariables(env: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
      // Simple variable substitution: ${VAR_NAME}
      const resolvedValue = value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
        if (varName === 'PROJECT_ROOT') {
          // Go up from backend/apps/api to the project root
          return path.resolve(process.cwd(), '../../..');
        }

        return process.env[varName] || '';
      });
      resolved[key] = resolvedValue;
    }

    return resolved;
  }
}
