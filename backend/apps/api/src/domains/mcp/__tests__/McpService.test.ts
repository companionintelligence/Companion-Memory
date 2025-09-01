import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import { EventService } from '@ci/domains/events';
import { ToolRegistry } from '@ci/domains/llm/tools';

import { McpService } from '../services/McpService';

// Mock dependencies
const mockEventService = {
  send: jest.fn(),
};

const mockToolRegistry = {
  getAvailableTools: jest.fn(),
  hasTool: jest.fn(),
  executeTool: jest.fn(),
};

describe('McpService', () => {
  let service: McpService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpService,
        {
          provide: EventService,
          useValue: mockEventService,
        },
        {
          provide: ToolRegistry,
          useValue: mockToolRegistry,
        },
        {
          provide: LoggerService,
          useValue: {
            debug: jest.fn(),
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<McpService>(McpService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockContext: RequestContext = {
    userId: 'test-user-123',
  };

  describe('getAvailableTools', () => {
    it('should return available MCP tools', async () => {
      const mockToolSchemas = [
        {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string' },
            },
          },
        },
      ];

      mockToolRegistry.getAvailableTools.mockReturnValue(mockToolSchemas);

      const result = await service.getAvailableTools(mockContext);

      expect(result).toEqual([
        {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: {
              input: { type: 'string' },
            },
          },
        },
      ]);

      expect(mockToolRegistry.getAvailableTools).toHaveBeenCalledWith(mockContext);
    });
  });

  describe('executeTool', () => {
    it('should execute tool and return success result', async () => {
      const toolCall = {
        name: 'test_tool',
        arguments: { input: 'test' },
      };

      const mockToolResult = {
        success: true,
        data: { output: 'test result' },
      };

      mockToolRegistry.executeTool.mockResolvedValue(mockToolResult);

      const result = await service.executeTool(mockContext, toolCall);

      expect(result.success).toBe(true);
      expect(result.content).toEqual({ output: 'test result' });
      expect(result.executionTimeMs).toBeDefined();
      expect(mockToolRegistry.executeTool).toHaveBeenCalledWith('test_tool', mockContext, { input: 'test' });
    });

    it('should handle tool execution failure', async () => {
      const toolCall = {
        name: 'test_tool',
        arguments: { input: 'test' },
      };

      const mockToolResult = {
        success: false,
        error: {
          message: 'Tool execution failed',
          code: 'EXECUTION_ERROR',
          retryable: true,
        },
      };

      mockToolRegistry.executeTool.mockResolvedValue(mockToolResult);

      const result = await service.executeTool(mockContext, toolCall);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Tool execution failed');
      expect(result.executionTimeMs).toBeDefined();
    });
  });

  describe('queueToolCall', () => {
    it('should queue tool call successfully', async () => {
      const request = {
        toolName: 'test_tool',
        arguments: { input: 'test' },
        userId: 'test-user-123',
        requestId: 'test-request-123',
      };

      mockToolRegistry.hasTool.mockReturnValue(true);
      mockEventService.send.mockResolvedValue('job-123');

      const result = await service.queueToolCall(mockContext, request);

      expect(result.success).toBe(true);
      expect(result.requestId).toBe('test-request-123');
      expect(mockEventService.send).toHaveBeenCalledWith('mcp.call', {
        toolName: 'test_tool',
        arguments: { input: 'test' },
        userId: 'test-user-123',
        requestId: 'test-request-123',
      });
    });

    it('should reject unknown tool', async () => {
      const request = {
        toolName: 'unknown_tool',
        arguments: {},
        userId: 'test-user-123',
      };

      mockToolRegistry.hasTool.mockReturnValue(false);

      const result = await service.queueToolCall(mockContext, request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Tool 'unknown_tool' not found");
      expect(mockEventService.send).not.toHaveBeenCalled();
    });

    it('should reject request without userId', async () => {
      const request = {
        toolName: 'test_tool',
        arguments: {},
        userId: '', // Empty userId
      };

      const result = await service.queueToolCall(mockContext, request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('User ID is required for MCP tool calls');
    });
  });
});
