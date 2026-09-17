import type { ToolProvider as ToolCoreProvider } from '@ci/tool-core';

import type { BaseTool } from '../core/BaseTool';

/**
 * A source of tools for the {@link ToolRegistry}. **The interface is defined in `@ci/tool-core`**;
 * this binds its tool-type parameter to `BaseTool`, the abstract class every tool in this
 * application extends.
 *
 * The package's registry only ever reads `schema` and calls `execute`, so it asks for no more than
 * that ({@link ToolHandle}). This application has more: `BaseTool` carries the uuid execution ids,
 * the input sanitizing and the error normalization that its 33 native tools share, and a provider
 * here hands back one of those — so `ToolRegistry.getTool` and `NativeToolProvider.getTool` keep
 * returning a `BaseTool`, exactly as before the extraction.
 */
export type ToolProvider = ToolCoreProvider<BaseTool>;

export type { ProviderHealthStatus } from '@ci/tool-core';
