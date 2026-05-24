import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key for body size limit configuration
 */
export const BODY_LIMIT_KEY = 'body_limit';

/**
 * Decorator to set a custom body size limit for a specific route.
 *
 * @param limit - The body size limit (e.g., '50mb', '1kb', '100kb')
 *
 * @example
 * ```typescript
 * @Post('upload')
 * @BodyLimit('50mb')
 * async upload(@Body() data: any) {
 *   return { status: 'success' };
 * }
 * ```
 */
export const BodyLimit = (limit: string) => SetMetadata(BODY_LIMIT_KEY, limit);
