import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { chunkedConflictInsert } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { PersonCreatedEvent, PersonUpdatedEvent, PersonRemovedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Person, PersonEntity } from '../entities/PersonEntity';
import { CreatePersonDto, NORMALIZED_PERSON_FIELDS, UpdatePersonDto } from '../types';

import { EntityService } from './EntityService';

/** Map properties JSONB identity keys onto the typed Person columns. */
function typedColumnsFromProperties(properties: Record<string, unknown> = {}): {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  birthDate: string | null;
  isSelf?: boolean;
} {
  const asText = (key: string): string | null => {
    const raw = properties[key];
    if (typeof raw !== 'string') {
      return null;
    }

    const trimmed = raw.trim();

    return trimmed === '' ? null : trimmed;
  };

  const cols: {
    firstName: string | null;
    middleName: string | null;
    lastName: string | null;
    birthDate: string | null;
    isSelf?: boolean;
  } = {
    firstName: asText('first_name'),
    middleName: asText('middle_name'),
    lastName: asText('last_name'),
    birthDate: asText('birth_date'),
  };

  if (properties.is_self === true || properties.is_self === 'true') {
    cols.isSelf = true;
  } else if (properties.is_self === false || properties.is_self === 'false') {
    cols.isSelf = false;
  }

  return cols;
}

@Injectable()
export class PersonService extends EntityService<PersonEntity, Person> {
  constructor(
    @InjectRepository(PersonEntity)
    personRepository: Repository<PersonEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
  ) {
    super(personRepository, PersonEntity);
    this.logger.setContext(PersonService.name);
  }

  /**
   * @param options.emitCreated When true (default) a PersonCreatedEvent is sent so
   *   the row indexes/enriches live. The bulk path passes false: emitting a per-row
   *   pgboss event for every ingested row is the dominant cost at import volume, so
   *   bulk-loaded rows are instead swept by the post-load search-index backfill.
   */
  async create(
    context: UserServiceContext,
    data: CreatePersonDto,
    options: { emitCreated?: boolean } = {},
  ): Promise<Person> {
    const { emitCreated = true } = options;

    // Idempotency: (owner_user_id, entity_type, linked_table, linked_id) is the
    // stable external key a capture source carries. Resolving-or-creating the
    // same linked person (a re-sync, a retry) must NOT duplicate it. The
    // `entity_type = 'Person'` half is enforced automatically by the STI child
    // repository, so it is not restated here.
    const linkedWhere =
      data.linkedTable && data.linkedId
        ? {
            linkedTable: data.linkedTable,
            linkedId: data.linkedId,
            userId: context.userId,
          }
        : null;

    if (linkedWhere) {
      const existing = await this.repository.findOne({ where: linkedWhere });
      if (existing) {
        return this.resolveTombstone(existing);
      }
    }

    const properties = data.properties || {};

    // Insert in a transaction (persistCreate is the seam where mutation
    // recording will land). Reaching past the catch means a genuine insert
    // happened (an idempotent race winner returns early), so the created event
    // always fires here.
    let entity: PersonEntity;
    try {
      entity = await this.repository.manager.transaction((manager) => {
        const instance = this.repository.create({
          id: data.id || uuid7(),
          name: data.name,
          description: data.description,
          linkedTable: data.linkedTable,
          linkedId: data.linkedId,
          searchContent: data.searchContent,
          lastAccessed: data.lastAccessed,
          userId: context.userId,
          properties,
          ...typedColumnsFromProperties(properties),
        });

        return this.persistCreate(manager, instance);
      });
    } catch (err) {
      // Lost a race to a concurrent insert of the same linked key (23505) —
      // return the winner. The recovery query must run outside the failed
      // transaction: the unique violation aborts it, so any further query on
      // that manager would fail with 25P02 instead.
      if (linkedWhere && (err as { code?: string })?.code === '23505') {
        const winner = await this.repository.findOne({ where: linkedWhere });
        if (winner) {
          return this.resolveTombstone(winner);
        }
      }

      throw err;
    }

    if (emitCreated) {
      await this.eventService.send(PersonCreatedEvent, {
        personId: entity.id,
      });
    }

    // Reload so @AfterLoad projects the normalized fields and DB-side defaults
    // (e.g. last_accessed) are present. `save` runs neither, and egress strips
    // the normalized keys out of `properties`, so the saved instance alone
    // would expose them in neither place.
    const created = await this.repository.findOne({ where: { id: entity.id } });

    return PersonEntity.toEgressType(created ?? entity);
  }

  /**
   * Batch, idempotent people ingest for the importer. Replaces the per-row
   * findOne + save + PersonCreatedEvent loop with one set-based
   * INSERT ... ON CONFLICT DO NOTHING (dedup on the (owner_user_id, entity_type,
   * linked_table, linked_id) provenance key via the existing entities_linked_uniq
   * partial unique index, which also absorbs a lost insert race) plus one
   * hydration SELECT. Re-syncing the same linked key returns the existing row
   * instead of duplicating it. Returns the created-or-existing people in input
   * order.
   *
   * Bulk ingest does NOT emit a per-row PersonCreatedEvent: the per-row pgboss
   * fan-out was the dominant cost at import volume. Search indexing for
   * bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). Single-row create() still
   * emits, so interactive creates index live.
   */
  async createMany(context: UserServiceContext, data: CreatePersonDto[]): Promise<Person[]> {
    if (data.length === 0) {
      return [];
    }

    // `entity_type` is not set here: the STI child metadata carries the
    // discriminator and TypeORM's insert builder emits it for every row.
    const entities = data.map((item) => {
      const properties = item.properties || {};

      return this.repository.create({
        id: item.id || uuid7(),
        name: item.name,
        description: item.description,
        linkedTable: item.linkedTable,
        linkedId: item.linkedId,
        searchContent: item.searchContent,
        lastAccessed: item.lastAccessed,
        userId: context.userId,
        properties,
        ...typedColumnsFromProperties(properties),
      });
    });

    // One set-based INSERT keyed on the linked provenance index, split into
    // param-budget-bounded chunks by chunkedConflictInsert so a large batch
    // never exceeds Postgres' 65535 bind-param limit. The conflict clause
    // targets entities_linked_uniq exactly (partial on linked_table IS NOT
    // NULL) so a re-synced linked row is a no-op and a lost insert race is
    // absorbed without throwing. Unlinked rows (no linked_table/linked_id)
    // fall outside the partial index and always insert, matching create()'s
    // behaviour.
    await chunkedConflictInsert(
      this.repository,
      entities,
      '(owner_user_id, entity_type, linked_table, linked_id) WHERE linked_table IS NOT NULL DO NOTHING',
    );

    // Hydrate the created-or-existing rows in input order: by id for the ones we
    // (may have) inserted, plus by linked key for any that a concurrent/prior
    // ingest already owned under a different id.
    return this.hydrateInInputOrder(context, entities);
  }

  /**
   * A linked-key hit on a merge tombstone must resolve to the CANONICAL person
   * — otherwise a re-sync of the merged-away source re-attaches its data to a
   * hidden entity. Single hop: merges always point tombstones at a live row.
   */
  private async resolveTombstone(entity: PersonEntity): Promise<Person> {
    if (entity.mergedIntoEntityId == null) {
      return PersonEntity.toEgressType(entity);
    }

    const canonical = await this.repository.findOne({
      where: { id: entity.mergedIntoEntityId },
    });

    return PersonEntity.toEgressType(canonical ?? entity);
  }

  /**
   * Resolve each built entity to its canonical persisted row (freshly inserted or
   * pre-existing under the same linked key), in input order. One SELECT (plus one
   * more when any resolved row is a merge tombstone, to follow the pointers).
   */
  private async hydrateInInputOrder(
    context: UserServiceContext,
    entities: PersonEntity[],
  ): Promise<Person[]> {
    const ids = entities.map((entity) => entity.id);

    const qb = this.repository
      .createQueryBuilder('person')
      // The STI child repository scopes the query to `entity_type = 'Person'`.
      .where('person.owner_user_id = :userId', { userId: context.userId })
      .andWhere(
        new Brackets((outer) => {
          outer.where('person.entity_id IN (:...ids)', { ids });

          const linked = entities.filter((entity) => entity.linkedTable && entity.linkedId);
          linked.forEach((entity, i) => {
            outer.orWhere(`(person.linked_table = :lt_${i} AND person.linked_id = :li_${i})`, {
              [`lt_${i}`]: entity.linkedTable,
              [`li_${i}`]: entity.linkedId,
            });
          });
        }),
      );

    const rows = await qb.getMany();

    const byId = new Map(rows.map((row) => [row.id, row]));
    const byLinked = new Map(
      rows
        .filter((row) => row.linkedTable && row.linkedId)
        .map((row) => [`${row.linkedTable} ${row.linkedId}`, row]),
    );

    const resolved = entities.map(
      (entity) =>
        byId.get(entity.id) ??
        (entity.linkedTable && entity.linkedId
          ? byLinked.get(`${entity.linkedTable} ${entity.linkedId}`)
          : undefined) ??
        entity,
    );

    // Linked-key hits on merge tombstones must resolve to the canonical rows
    // (one extra SELECT for the pointer targets, only when any exist).
    const canonicalIds = [
      ...new Set(resolved.map((row) => row.mergedIntoEntityId).filter((id): id is string => id != null)),
    ];

    const canonicalById = new Map<string, PersonEntity>();
    if (canonicalIds.length > 0) {
      const canonicalRows = await this.repository.find({ where: { id: In(canonicalIds) } });
      for (const row of canonicalRows) {
        canonicalById.set(row.id, row);
      }
    }

    return resolved.map((row) =>
      PersonEntity.toEgressType(
        row.mergedIntoEntityId != null ? (canonicalById.get(row.mergedIntoEntityId) ?? row) : row,
      ),
    );
  }

  /**
   * List people, excluding merge tombstones and deactivated rows. `query`
   * filters by display name or structured first/last name (ILIKE substring) —
   * the people index page's search box.
   *
   * Overrides {@link EntityService.findAll}, which knows neither of those
   * person-specific concerns.
   */
  async findAll(context: ServiceContext, options: { query?: string } = {}): Promise<Person[]> {
    // The STI child repository scopes the query to `entity_type = 'Person'`.
    let qb = this.repository
      .createQueryBuilder('person')
      .where('person.is_active IS DISTINCT FROM FALSE')
      .andWhere('person.merged_into_entity_id IS NULL');

    if (context.userId !== SYSTEM_USER) {
      qb = qb.andWhere('person.owner_user_id = :userId', { userId: context.userId });
    }

    const query = options.query?.trim();
    if (query) {
      qb = qb.andWhere(
        new Brackets((outer) => {
          outer
            .where('person.name ILIKE :q', { q: `%${query}%` })
            .orWhere(`person.properties->>'first_name' ILIKE :q`, { q: `%${query}%` })
            .orWhere(`person.properties->>'last_name' ILIKE :q`, { q: `%${query}%` });
        }),
      );
    }

    const entities = await qb
      .orderBy(`NULLIF(btrim(COALESCE(person.name, '')), '')`, 'ASC', 'NULLS LAST')
      .addOrderBy('person.created_at', 'DESC')
      .getMany();

    return entities.map((entity) => PersonEntity.toEgressType(entity));
  }

  /**
   * Lightweight identifiers for the most-recent people, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForPeople(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.repository
      .createQueryBuilder('person')
      .select('person.id', 'id')
      // The STI child repository scopes the query to `entity_type = 'Person'`.
      .where('person.owner_user_id = :userId', { userId: context.userId })
      .andWhere('person.is_active IS DISTINCT FROM FALSE')
      .andWhere('person.merged_into_entity_id IS NULL');

    if (options.startTime) {
      query = query.andWhere('person.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('person.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('person.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'person' as IndexableEntity }));
  }

  async update(context: ServiceContext, id: string, data: UpdatePersonDto): Promise<Person | null> {
    const { properties, ...rest } = data;

    const after = await this.applyUpdate(context, id, (before) => {
      if (!properties) {
        return rest;
      }

      // Callers routinely round-trip an egress bag, and toEgressType strips
      // the normalized keys from it (they live on the named fields instead).
      // An absent normalized key therefore means "unchanged", not "cleared":
      // carry the stored value over, and only sync a typed column when its
      // storage key is explicitly present in the incoming bag.
      const stored = (before.properties ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...properties };
      for (const [storageKey] of NORMALIZED_PERSON_FIELDS) {
        if (!(storageKey in properties) && storageKey in stored) {
          merged[storageKey] = stored[storageKey];
        }
      }

      const typedAll = typedColumnsFromProperties(properties);
      const typed: {
        firstName?: string | null;
        middleName?: string | null;
        lastName?: string | null;
        birthDate?: string | null;
        isSelf?: boolean;
      } = {};

      if ('first_name' in properties) {
        typed.firstName = typedAll.firstName;
      }

      if ('middle_name' in properties) {
        typed.middleName = typedAll.middleName;
      }

      if ('last_name' in properties) {
        typed.lastName = typedAll.lastName;
      }

      if ('birth_date' in properties) {
        typed.birthDate = typedAll.birthDate;
      }

      if (typedAll.isSelf !== undefined) {
        typed.isSelf = typedAll.isSelf;
      }

      return {
        ...rest,
        ...typed,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: merged as any, // TypeORM will handle JSON serialization
      };
    });

    if (!after) {
      return null;
    }

    await this.eventService.send(PersonUpdatedEvent, {
      personId: id,
    });

    return PersonEntity.toEgressType(after);
  }

  /**
   * Partial update for the structured-person editor: merges `propertiesPatch`
   * into the existing properties JSONB (single-statement `properties || patch`,
   * so concurrent patches to different keys don't clobber each other) and
   * updates name/description only when provided. A patch key set to null
   * clears that property.
   */
  async patch(
    context: ServiceContext,
    id: string,
    data: { name?: string; description?: string; propertiesPatch?: Record<string, unknown> },
  ): Promise<Person | null> {
    const set: Record<string, unknown> = {};
    if (data.name !== undefined) {
      set.name = data.name;
    }

    if (data.description !== undefined) {
      set.description = data.description;
    }

    if (data.propertiesPatch && Object.keys(data.propertiesPatch).length > 0) {
      set.properties = () => `properties || :propertiesPatch::jsonb`;
      // Keep typed columns in sync with the structured-person editor patch.
      const typed = typedColumnsFromProperties(data.propertiesPatch);
      if ('first_name' in data.propertiesPatch) {
        set.firstName = typed.firstName;
      }

      if ('middle_name' in data.propertiesPatch) {
        set.middleName = typed.middleName;
      }

      if ('last_name' in data.propertiesPatch) {
        set.lastName = typed.lastName;
      }

      if ('birth_date' in data.propertiesPatch) {
        set.birthDate = typed.birthDate;
      }

      if ('is_self' in data.propertiesPatch) {
        // Explicit null/false clears the self flag; omit → leave column alone.
        set.isSelf = typed.isSelf ?? null;
      }
    }

    if (Object.keys(set).length === 0) {
      return this.findById(context, id);
    }

    let qb = this.repository
      .createQueryBuilder()
      .update()
      .set(set)
      .where('entity_id = :id', { id })
      .andWhere(`entity_type = 'Person'`);

    if (context.userId !== SYSTEM_USER) {
      qb = qb.andWhere('owner_user_id = :userId', { userId: context.userId });
    }

    if (set.properties) {
      qb = qb.setParameter('propertiesPatch', JSON.stringify(data.propertiesPatch));
    }

    const result = await qb.execute();

    if ((result.affected ?? 0) === 0) {
      return null;
    }

    await this.eventService.send(PersonUpdatedEvent, {
      personId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const removed = await this.delete(context, id);

    if (!removed) {
      return false;
    }

    await this.eventService.send(PersonRemovedEvent, {
      personId: id,
    });

    return true;
  }

  async search(context: ServiceContext, query: UpdatePersonDto): Promise<Person[]> {
    let executable = this.repository
      .createQueryBuilder('entity')
      .where('owner_user_id = :userId', { userId: context.userId });

    if (query.name) {
      executable = executable.andWhere('name = :name', { name: query.name });
    }

    if (query.description) {
      executable = executable.andWhere('description = :description', { description: query.description });
    }

    if (query.linkedId) {
      executable = executable.andWhere('linked_id = :linkedId', { linkedId: query.linkedId });
    }

    if (query.linkedTable) {
      executable = executable.andWhere('linked_table = :linkedTable', { linkedTable: query.linkedTable });
    }

    if (query.properties) {
      for (const [key, val] of Object.entries(query.properties)) {
        executable = executable.andWhere(`entity.properties->>'${key}' = :${key}`, { [key]: val });
      }
    }

    const entities = await executable.getMany();

    return entities.map((entity) => PersonEntity.toEgressType(entity));
  }
}
