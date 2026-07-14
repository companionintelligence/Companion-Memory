import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Default hard ceiling on how many elements a single bulk-create mutation input
 * array may carry. Sized well above the importer's realistic push batches
 * (CI_PUSH_BATCH_SIZE defaults to 200, and it splits on HTTP 413) but low enough
 * to reject a runaway single request before the server materialises the whole
 * array in memory / opens one very large transaction. The 65535 bind-param limit
 * is handled separately by `bulkInsertIdempotent`'s internal chunking, so this cap
 * exists to bound request size and lock scope, not param count.
 */
export const MAX_BULK_INPUT_SIZE = 10000;

/**
 * Param-scoped pipe rejecting an oversized array argument with a 400 before it
 * reaches the resolver. The GraphQL bulk-create mutations
 * (createEvents / createCommunications / createInventoryItems /
 * createBrowserActivities) pass their input array through with no built-in
 * size guard, so this is the analogue of class-validator's `@ArrayMaxSize` for a
 * top-level array arg. class-validator is not a dependency of this app (the
 * codebase validates with the Zod-based `ValidationPipe`), so the cap is enforced
 * here as a plain PipeTransform instead of a decorator.
 */
@Injectable()
export class MaxArraySizePipe implements PipeTransform<unknown[], unknown[]> {
  constructor(private readonly max: number = MAX_BULK_INPUT_SIZE) {}

  transform(value: unknown[]): unknown[] {
    if (Array.isArray(value) && value.length > this.max) {
      throw new BadRequestException(
        `Input array too large: ${value.length} items exceeds the maximum of ${this.max}. ` +
          `Split the payload into batches of at most ${this.max}.`,
      );
    }

    return value;
  }
}
