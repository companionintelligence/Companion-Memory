import { Module } from '@nestjs/common';

import { ToolRegistry } from './registry/ToolRegistry';

@Module({
  providers: [ToolRegistry],
  exports: [ToolRegistry],
})
export class ToolsModule {}

// Core exports for the tools domain
export { ToolRegistry };
export type { ToolSchema, ToolResult, ToolExecutionContext, ToolError } from './core/types';
export type { ProviderHealthStatus } from './providers/ToolProvider';
