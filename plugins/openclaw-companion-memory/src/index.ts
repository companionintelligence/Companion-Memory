/**
 * @companion-intelligence/openclaw-memory
 *
 * Entry point: exports the CompanionMemoryProvider class and a createPlugin
 * factory function for convenient integration with OpenClaw.
 */

export { CompanionMemoryProvider } from './provider.js';
export type { ProviderConfig, Message, MemorySearchResult } from './provider.js';
export { CompanionClient } from './client.js';
export type { PostContextRequest, PostContextResponse } from './client.js';
export { ALL_TOOL_SCHEMAS, memorySearchSchema, memoryGetSchema, companionRememberSchema } from './tools.js';
export type { OpenClawToolSchema } from './tools.js';

import { CompanionMemoryProvider, type ProviderConfig } from './provider.js';
import { ALL_TOOL_SCHEMAS } from './tools.js';

export interface OpenClawPlugin {
  provider: CompanionMemoryProvider;
  tools: typeof ALL_TOOL_SCHEMAS;
}

/**
 * Factory function for registering the Companion memory plugin with OpenClaw.
 *
 * @example
 * ```ts
 * import { createPlugin } from "@companion-intelligence/openclaw-memory";
 *
 * const plugin = createPlugin({
 *   apiKey: process.env.COMPANION_API_KEY!,
 *   baseUrl: "https://api.companion.intelligence",
 * });
 *
 * openClaw.use(plugin);
 * ```
 */
export function createPlugin(config: ProviderConfig): OpenClawPlugin {
  return {
    provider: new CompanionMemoryProvider(config),
    tools: ALL_TOOL_SCHEMAS,
  };
}
