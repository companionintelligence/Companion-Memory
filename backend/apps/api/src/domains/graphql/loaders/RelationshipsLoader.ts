import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { GraphQueryService } from '@ci/domains/memory';

import { Loader } from './Loader';

export type RelationshipDirection = 'outbound' | 'inbound';
type Relationship = Awaited<ReturnType<GraphQueryService['getRelationships']>>[number];

/**
 * Batches the `outgoingRelationships` / `incomingRelationships` fields of a
 * page of people or places into one ranked query per direction and limit:
 * each entity's newest `limit` edges, instead of every edge of every entity,
 * one query per row, sliced in memory.
 *
 * The key is `(direction, limit, entityId)` — {@link loadFor} spells it — so two
 * fields asking for different limits on the same entity are different keys.
 */
@Injectable()
export class RelationshipsLoader extends Loader<Relationship[]> {
  constructor(
    private readonly graphQuery: GraphQueryService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(RelationshipsLoader.name);
  }

  loadFor(
    context: UserServiceContext,
    entityId: string,
    direction: RelationshipDirection,
    limit: number,
  ): Promise<Relationship[]> {
    return this.load(context, `${direction}:${limit}:${entityId}`);
  }

  protected async batchLoad(
    context: UserServiceContext,
    keys: readonly string[],
  ): Promise<readonly Relationship[][]> {
    const parsed = keys.map((key) => {
      const [direction, limit, ...rest] = key.split(':');

      return {
        direction: direction as RelationshipDirection,
        limit: Number(limit),
        entityId: rest.join(':'),
      };
    });
    const groups = new Map<
      string,
      { direction: RelationshipDirection; limit: number; entityIds: string[] }
    >();

    for (const { direction, limit, entityId } of parsed) {
      const group = groups.get(`${direction}:${limit}`) ?? { direction, limit, entityIds: [] };

      if (!group.entityIds.includes(entityId)) {
        group.entityIds.push(entityId);
      }

      groups.set(`${direction}:${limit}`, group);
    }

    this.logger.log(`Loading relationships for a batch of ${keys.length} entities`);

    const results = new Map<string, Map<string, Relationship[]>>();

    await Promise.all(
      [...groups.entries()].map(async ([name, group]) => {
        results.set(name, await this.graphQuery.getRelationshipsPerEntity(context.userId, group));
      }),
    );

    return parsed.map(
      ({ direction, limit, entityId }) => results.get(`${direction}:${limit}`)?.get(entityId) ?? [],
    );
  }
}
