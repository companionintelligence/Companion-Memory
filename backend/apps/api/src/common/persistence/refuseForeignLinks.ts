import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** One link a writer is about to store, and the row it has to name. */
export interface OwnedLink {
  /** The column being written, as the caller sent it (`place_entity_id`). */
  field: string;
  /** The table the id names, schema-qualified and already quoted where needed (`ci.entities`). */
  table: string;
  key: string;
  /** That table's owner column (`owner_user_id`, `user_id`). */
  ownerColumn: string;
  ids: ReadonlyArray<string | null | undefined>;
}

/**
 * Refuse a write whose links name a row of another account, or a row with no owner.
 *
 * A foreign key only asks that the row exists, and some link columns have none,
 * so a writer that took an id on trust stored a link from this account's row to
 * someone else's: a receipt at another account's place. Such a link shows their
 * row in this account's graph, and it is also what an import of this account's
 * own export refuses (`UserDataPortabilityService.refuseLinksOutOfAccount`), so
 * the account could no longer restore its export. An id that names no row is
 * left to the column's key, if it has one.
 *
 * `field`, `table`, `key` and `ownerColumn` come from the caller's code, never
 * from the request.
 */
export async function refuseForeignLinks(
  manager: Pick<EntityManager, 'query'>,
  ownerId: string,
  links: readonly OwnedLink[],
  what: string,
): Promise<void> {
  for (const { field, table, key, ownerColumn, ids } of links) {
    const named = [...new Set(ids.filter((id): id is string => id != null))];

    if (named.length === 0) {
      continue;
    }

    const [found] = ((await manager.query(
      `SELECT ${key}::text AS id FROM ${table}
        WHERE ${key} = ANY($1::uuid[]) AND ${ownerColumn} IS DISTINCT FROM $2::uuid
        LIMIT 1`,
      [named, ownerId],
    )) ?? []) as Array<{ id: string }>;

    if (found) {
      throw new BadRequestException(
        `${field} ${found.id} is a row of ${table} that belongs to another account or to none, so the ${what} was refused.`,
      );
    }
  }
}
