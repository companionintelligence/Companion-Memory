import { BaseTool } from '../../core/BaseTool';
import type { ToolSchema, ToolExecutionContext } from '../../core/types';

import type { McpToolProvider } from './McpToolProvider';

/**
 * Wrapper class to adapt MCP tools to our BaseTool interface
 */
export class McpToolWrapper extends BaseTool {
  readonly schema: ToolSchema;

  constructor(
    schema: ToolSchema,
    private readonly mcpProvider: McpToolProvider,
    private readonly serverName: string,
    private readonly originalToolName: string,
  ) {
    super();
    this.schema = schema;
  }

  protected async executeInternal(context: ToolExecutionContext, input: unknown): Promise<unknown> {
    const result = await this.mcpProvider.executeServerTool(this.serverName, this.originalToolName, input);

    if (!result.success) {
      throw new Error(result.error || 'MCP tool execution failed');
    }

    return result.content;
  }
}
