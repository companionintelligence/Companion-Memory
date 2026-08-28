import type { LoggerService } from '@ci/common/logging';
import { BaseTool, type IntentDefinition, type ToolExecutionContext } from '@ci/domains/tools';

/**
 * One reusable wrapper around every tool discovered from an external MCP server. Each instance is
 * a single tool: the synthesized {@link IntentDefinition} (fixed `mcp` domain/privacy — see
 * {@link McpToolProvider} — plus the server's real description/inputSchema) and a bound closure
 * that routes the call back through {@link McpClientManagerService.callTool}.
 *
 * `executeInternal` deliberately does no unwrapping/error-shaping of its own beyond what the
 * closure already does (`McpClientManagerService.callTool` throws on `isError: true` and unwraps
 * `structuredContent`/text content) — `BaseTool.execute`'s existing try/catch turns that throw into
 * a normal failed {@link ToolResult}, so there is nothing bespoke to do here.
 */
export class McpDynamicTool extends BaseTool<unknown, unknown> {
  readonly schema: IntentDefinition;

  protected logger: LoggerService;

  constructor(
    schema: IntentDefinition,
    logger: LoggerService,
    private readonly invoke: (input: unknown) => Promise<unknown>,
  ) {
    super();
    this.schema = schema;
    this.logger = logger;
  }

  protected async executeInternal(_context: ToolExecutionContext, input: unknown): Promise<unknown> {
    return this.invoke(input);
  }
}
