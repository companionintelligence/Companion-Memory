import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type ObjectObservation, ObjectObservationEntity } from '@ci/domains/memory';

import { Loader } from './Loader';

/**
 * Sightings returned per unit.
 *
 * A single thing photographed daily accumulates thousands of observations, and
 * a detail drawer shows a strip of them. Capping here keeps one popular object
 * from turning a page of twelve items into a hundred-thousand-row read; the
 * full history is a paged query's job, not a field resolver's.
 */
const MAX_OBSERVATIONS_PER_ITEM = 20;

/**
 * Batches `ItemType.observations` into one `ci.object_observations` query.
 *
 * Reads the repository directly rather than going through
 * `ObjectObservationService`: its `find` filter has no `resolvedObjectId`
 * predicate, so the only service-shaped alternative is one query per item —
 * the exact N+1 a loader exists to prevent. The read is scoped on `user_id`
 * here for the same reason every service scopes it: an unscoped read of a
 * shared table is a cross-tenant leak, whatever layer it happens in.
 */
@Injectable()
export class ItemObservationLoader extends Loader<ObjectObservation[]> {
  constructor(
    @InjectRepository(ObjectObservationEntity)
    private readonly repository: Repository<ObjectObservationEntity>,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ItemObservationLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    itemIds: readonly string[],
  ): Promise<readonly ObjectObservation[][]> {
    if (itemIds.length === 0) {
      return [];
    }

    const rows = await this.repository.find({
      where: { userId: context.userId, resolvedObjectId: In([...itemIds]) },
      order: { observedAt: 'DESC', id: 'DESC' },
    });

    const byItem = new Map<string, ObjectObservation[]>();

    for (const row of rows) {
      // Non-null by the predicate above; the column is nullable in general.
      const key = row.resolvedObjectId;
      if (key == null) {
        continue;
      }

      const list = byItem.get(key);
      if (list == null) {
        byItem.set(key, [row]);
      } else if (list.length < MAX_OBSERVATIONS_PER_ITEM) {
        list.push(row);
      }
    }

    return itemIds.map((id) => byItem.get(id) ?? []);
  }
}
