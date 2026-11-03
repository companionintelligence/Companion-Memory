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
 * The tables a link names: each one's key and the column that says whose row it is, the
 * same column the import scopes the table by. Spread into an {@link OwnedLink}.
 */
export const OWNED_TABLES = {
  content: { table: 'ci.content', key: 'id', ownerColumn: 'user_id' },
  entities: { table: 'ci.entities', key: 'entity_id', ownerColumn: 'owner_user_id' },
  events: { table: 'ci.events', key: 'event_id', ownerColumn: 'user_id' },
  files: { table: 'ci.files', key: 'id', ownerColumn: 'user_id' },
  objects: { table: 'ci.objects', key: 'object_id', ownerColumn: 'user_id' },
  productModels: { table: 'ci.product_models', key: 'product_id', ownerColumn: 'user_id' },
} as const satisfies Record<string, Pick<OwnedLink, 'table' | 'key' | 'ownerColumn'>>;

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
 * Every link is checked in one statement, and the first one listed that names
 * a foreign row is the one the refusal names.
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
  const checked = links
    .map((link) => ({ link, named: [...new Set(link.ids.filter((id): id is string => id != null))] }))
    .filter(({ named }) => named.length > 0);

  if (checked.length === 0) {
    return;
  }

  const lookups = checked.map(
    ({ link: { table, key, ownerColumn } }, index) =>
      `(SELECT ${index} AS link, ${key}::text AS id FROM ${table}
         WHERE ${key} = ANY($${index + 2}::uuid[]) AND ${ownerColumn} IS DISTINCT FROM $1::uuid
         LIMIT 1)`,
  );
  const [found] = ((await manager.query(
    `SELECT link, id FROM (${lookups.join('\n UNION ALL ')}) foreign_link ORDER BY link LIMIT 1`,
    [ownerId, ...checked.map(({ named }) => named)],
  )) ?? []) as Array<{ link: number; id: string }>;

  if (found) {
    const { field, table } = checked[found.link].link;

    throw new BadRequestException(
      `${field} ${found.id} is a row of ${table} that belongs to another account or to none, so the ${what} was refused.`,
    );
  }
}
