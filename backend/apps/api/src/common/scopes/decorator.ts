import { SetMetadata } from '@nestjs/common';

import type { Scope } from './taxonomy';

/**
 * Metadata key for required scopes on a route handler.
 */
export const SCOPES_METADATA_KEY = 'auth:required_scopes';

/**
 * Declare the API-key scopes required to call this route.
 *
 * - When the caller is authenticated via session JWT (i.e. the human owner
 *   in their own UI), scopes are not checked — the user has full access.
 * - When the caller is authenticated via API key, the key's `scopes` must
 *   satisfy every required scope listed here (wildcards allowed).
 * - Routes with no `@Scopes()` decorator are not gated at all.
 *
 * @example
 * ```typescript
 * @Get('/entities/:id')
 * @Scopes(SCOPES.MEMORY_READ)
 * async getEntity(...) { ... }
 *
 * @Post('/entities')
 * @Scopes(SCOPES.MEMORY_WRITE)
 * async createEntity(...) { ... }
 * ```
 */
export const Scopes = (...scopes: Scope[]) => SetMetadata(SCOPES_METADATA_KEY, scopes);
