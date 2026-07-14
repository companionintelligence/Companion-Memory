import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key under which required API-key scopes are stored for a route.
 */
export const REQUIRE_SCOPES_KEY = 'require_scopes';

/**
 * Canonical names of the API-key scopes. Defined once so the connect flow that
 * MINTS scoped keys (see ConnectService's `scopesForApp`) and the routes that
 * REQUIRE them via {@link RequireScopes} reference the same values and can never
 * silently drift.
 *
 * - `memory` — the `/memory/*` endpoints (all agent apps).
 * - `intents` — the agent intent catalog (`/api/intents`), used by CI-OpenClaw.
 * - `mcp` — the Model Context Protocol endpoint (`/mcp`), used by CI-Hermes.
 */
export const MEMORY_SCOPE = 'memory';
export const INTENTS_SCOPE = 'intents';
export const MCP_SCOPE = 'mcp';

/**
 * Declares the API-key scopes a route grants to scope-limited keys.
 *
 * Enforced deny-by-default by `enforceApiKeyScopes`, which runs inside the
 * api-key auth guards ({@link ApiKeyGuard} / {@link JwtOrApiKeyAuthGuard}) once
 * the strategy has populated `req.apiKeyScopes`. Semantics (least-privilege
 * with back-compat):
 *
 * - Callers authenticated by something other than an api-key (session/JWT/
 *   Portal bearer) are unaffected — they carry full user authority.
 * - An api-key with an **empty** `scopes` array is grandfathered as full-access
 *   (legacy keys, and connect keys minted for broad-access apps, keep working).
 * - An api-key with a **non-empty** `scopes` array is confined: it may reach a
 *   route ONLY if the route declares `@RequireScopes` and the key carries every
 *   scope listed, otherwise the request is rejected with 403. A scoped key on a
 *   route with no `@RequireScopes` is denied.
 *
 * @param scopes - one or more scope identifiers the route grants (e.g. `'memory'`)
 *
 * @example
 * ```typescript
 * @UseGuards(ApiKeyGuard)
 * @RequireScopes('memory')
 * @Post('write')
 * async write() { ... }
 * ```
 */
export const RequireScopes = (...scopes: string[]) => SetMetadata(REQUIRE_SCOPES_KEY, scopes);
