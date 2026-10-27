import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { chunkedConflictInsert, keysetSeek } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import {
  USER_EDITED_KEYS,
  userEditedKeys,
  userEditedListSql,
} from '@ci/domains/graph/utils/ingestedProperties';
import { PersonCreatedEvent, PersonUpdatedEvent, PersonRemovedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Person, PersonEntity } from '../entities/PersonEntity';
import { CreatePersonDto, NORMALIZED_PERSON_FIELDS, UpdatePersonDto } from '../types';

import {
  appearanceParams,
  appearanceWindowParams,
  hasDateWindow,
  mapAppearanceRows,
  ownerUserId,
  personAppearanceCountSql,
  personAppearanceListSql,
} from './appearanceBrowse';
import { EntityService } from './EntityService';
import { GraphDeltaWriter, changedFieldsBetween } from './GraphDeltaWriter';
import { type JsonbLeafPatch, buildJsonbLeafPatchSql } from './jsonbLeafPatch';
import { type PurgedPeople, purgePersonAggregates } from './personPurge';

/**
 * Keys a sync stamps into a person's bag on every run, whatever else it changes:
 * Google Contacts' `last_synced_at` and Facebook's `facebook_data.last_synced`.
 */
const SYNC_STAMP_KEYS = new Set(['last_synced', 'last_synced_at']);

/**
 * A properties value without its sync stamps, at any depth, for Change History.
 * A re-sync that moves only a stamp has not changed the person, and recording
 * one would add a row per contact on every sync.
 */
function withoutSyncStamps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutSyncStamps);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SYNC_STAMP_KEYS.has(key))
        .map(([key, nested]) => [key, withoutSyncStamps(nested)]),
    );
  }

  return value;
}

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

/**
 * Ranks a name that is unlikely to be a plausible human name (0 = plausible,
 * 1 = not) — used as the PRIMARY key of the default people-list ordering, so
 * bare digit-strings/phone-numbers and call-log-heading leftovers sink below
 * actually-named contacts instead of alphabetizing ahead of them ('1', '2', …
 * sort before 'A' in plain ASC order, which is exactly the bug: a live import
 * had 5,420 of 7,976 Person rows named things like "1003" or "+12013836559",
 * and every one of them beat a real name onto page 1).
 *
 * Deliberately narrow and DB-side only: it changes ranking, not membership —
 * a bad-named row still appears, still matches search, just isn't first.
 * It does not touch the data itself; existing garbage names are a separate,
 * out-of-scope backfill.
 *
 * The three shapes ranked down:
 *   - no name at all (NULL, or all-whitespace) — ranked here rather than left
 *     to fall through to ELSE, because Postgres' three-valued logic means a
 *     NULL name matches neither regex below (`NULL ~ x` is NULL, not false)
 *     and would otherwise land in the *plausible* tier ahead of the very
 *     digit-strings this exists to demote.
 *   - digit-only / phone-formatted names ("1003", "11112000", "+12013836559")
 *   - call-log headings a parser bug once wrote as the literal contact name
 *     ("Missed call from\n") — see 3e5956cb0, "a call-log heading is not a
 *     person"; that commit stops FUTURE imports from producing these, but
 *     does not rewrite rows that already exist.
 *
 * These come straight from a live-import audit.
 */
const PERSON_NAME_LOOKS_IMPLAUSIBLE_SQL = `CASE
  WHEN person.name IS NULL OR btrim(person.name) = '' THEN 1
  WHEN person.name ~ '^\\s*[+(]?[0-9][0-9()\\-.\\s]*$' THEN 1
  WHEN person.name ~* '^\\s*(missed|placed|received|recorded|voicemail)\\y' THEN 1
  ELSE 0
END`;

/**
 * A jsonb value with the form's empties (JSON null, `""`, `[]`) read as SQL
 * NULL, so a field the form sends back blank compares equal to one the row
 * never had.
 */
function emptyJsonbSql(value: string): string {
  return `NULLIF(NULLIF(NULLIF(${value}, 'null'::jsonb), '""'::jsonb), '[]'::jsonb)`;
}

/**
 * `{"user_edited_keys": […]}` for a hand edit in {@link PersonService.patch}, or
 * `{}` when there is nothing to list: the keys already listed, plus each
 * patched key whose stored value differs from the one arriving (missing, null,
 * `""` and `[]` all read as empty, so clearing a value that was there counts and
 * "clearing" an absent one does not), plus `name` / `description` when this
 * edit changes the column (NULL and `''` alike: the form sends a blank
 * description as `''`). Evaluated inside the UPDATE, so `properties`, `name`
 * and `description` are the row as it was before this statement.
 */
function handEditedKeysSql(data: { name?: string; description?: string }): string {
  const sources = [
    `SELECT held.member #>> '{}' AS key FROM jsonb_array_elements(${userEditedListSql('properties')}) AS held(member) ` +
      `WHERE jsonb_typeof(held.member) = 'string'`,
    `SELECT patched.key FROM jsonb_each(:propertiesPatch::jsonb) AS patched(key, value) ` +
      `WHERE ${emptyJsonbSql('properties -> patched.key')} IS DISTINCT FROM ${emptyJsonbSql('patched.value')}`,
    ...(data.name !== undefined
      ? [`SELECT 'name' WHERE NULLIF(name, '') IS DISTINCT FROM NULLIF(CAST(:editedName AS text), '')`]
      : []),
    ...(data.description !== undefined
      ? [
          `SELECT 'description' WHERE NULLIF(description, '') IS DISTINCT FROM ` +
            `NULLIF(CAST(:editedDescription AS text), '')`,
        ]
      : []),
  ];

  return (
    `(SELECT CASE WHEN listed.keys IS NULL THEN '{}'::jsonb ` +
    `ELSE jsonb_build_object('${USER_EDITED_KEYS}', listed.keys) END ` +
    `FROM (SELECT jsonb_agg(DISTINCT edited.key ORDER BY edited.key) AS keys ` +
    `FROM (${sources.join(' UNION ')}) AS edited) AS listed)`
  );
}

@Injectable()
export class PersonService extends EntityService<PersonEntity, Person> {
  constructor(
    @InjectRepository(PersonEntity)
    personRepository: Repository<PersonEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
    // Change History. Optional so unit harnesses that build the service by hand
    // keep working; the module always provides it.
    @Optional() private readonly graphDeltaWriter?: GraphDeltaWriter,
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
      entity = await this.repository.manager.transaction(async (manager) => {
        const instance = this.repository.create({
          id: data.id || uuid7(),
          name: data.name,
          description: data.description,
          linkedTable: data.linkedTable,
          linkedId: data.linkedId,
          searchContent: data.searchContent,
          userId: context.userId,
          properties,
          ...typedColumnsFromProperties(properties),
        });

        const saved = await this.persistCreate(manager, instance);

        await this.graphDeltaWriter?.entityCreated({
          entityId: saved.id,
          entityType: 'Person',
          name: saved.name,
          description: saved.description,
          properties: saved.properties,
          ownerUserId: context.userId,
          changeSource: 'PersonService.create',
          changedByUserId: context.userId,
          manager,
        });

        return saved;
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
    // (e.g. created_at) are present. `save` runs neither, and egress strips
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
      .orderBy(PERSON_NAME_LOOKS_IMPLAUSIBLE_SQL, 'ASC')
      .addOrderBy(`NULLIF(btrim(COALESCE(person.name, '')), '')`, 'ASC', 'NULLS LAST')
      .addOrderBy('person.created_at', 'DESC')
      .getMany();

    return entities.map((entity) => PersonEntity.toEgressType(entity));
  }

  /**
   * The calling owner's own Person entity — the single row per owner where
   * `is_self` is true (set at onboarding; see
   * `OnboardingService.createPersonForUser`). This is a fresh lookup on
   * `is_self` rather than a cached pointer such as `users.entity_id`, because
   * a merge can move `is_self` onto a different row (`PersonMergeService`)
   * without anything updating that pointer to follow it.
   *
   * Excludes merge tombstones the same way `findAll` does. Returns null —
   * never throws — when the owner has no `is_self` Person yet.
   */
  async findSelf(context: ServiceContext): Promise<Person | null> {
    let qb = this.repository
      .createQueryBuilder('person')
      .where('person.is_self IS TRUE')
      .andWhere('person.merged_into_entity_id IS NULL');

    if (context.userId !== SYSTEM_USER) {
      qb = qb.andWhere('person.owner_user_id = :userId', { userId: context.userId });
    }

    const entity = await qb.getOne();

    return entity ? PersonEntity.toEgressType(entity) : null;
  }

  /**
   * Lightweight identifiers for the most-recent people, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   *
   * With no date window this is the unique people list, ordered by row-write
   * time (the frontend puts undated people in "No date"). With a date window
   * the list is people who actually appeared in that window, ordered by first
   * real activity in it — not `created_at`, which is usually the import day.
   */
  async getEntitiesForPeople(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    if (hasDateWindow(options)) {
      return this.listPeopleByAppearance(context, options);
    }

    let query = this.repository
      .createQueryBuilder('person')
      .select('person.id', 'id')
      // The STI child repository scopes the query to `entity_type = 'Person'`.
      .where('person.owner_user_id = :userId', { userId: context.userId })
      .andWhere('person.is_active IS DISTINCT FROM FALSE')
      .andWhere('person.merged_into_entity_id IS NULL');

    // Composite keyset: page strictly past (afterTime, afterId) in (updated_at, entity_id), in
    // `order` — see keysetSeek.
    const order = options.order ?? 'DESC';

    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        ...keysetSeek('person.updated_at', 'person.entity_id', order, options.afterTime, options.afterId),
      );
    }

    // Deterministic tiebreak so same-timestamp rows page consistently: the id runs the way the time does.
    query = query.orderBy('person.updated_at', order).addOrderBy('person.entity_id', order);

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'person' as IndexableEntity }));
  }

  /**
   * Date-windowed People browse: one row per person, timestamped at MIN(real
   * activity in the window) — events as organizer/participant (excluding ingest
   * wall-clock times) and communications as from/to. People with no activity in
   * the window drop out. See appearanceBrowse.ts.
   */
  private async listPeopleByAppearance(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    },
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const userId = ownerUserId(context.userId);
    if (userId == null) {
      return [];
    }

    const rows = await this.repository.manager.query<Array<{ id: string; appearedAt: Date | string }>>(
      personAppearanceListSql(options.order ?? 'DESC'),
      appearanceParams(userId, options),
    );

    return mapAppearanceRows(rows, 'person');
  }

  /**
   * True total of people matching the same filters {@link getEntitiesForPeople} applies (minus
   * the pagination-only `limit`/`order`/`afterTime`/`afterId`) — a real `COUNT(*)`, not the
   * length of one `limit`-bounded page of identifiers. See CalendarEventService.countEntitiesForEvents.
   */
  async countEntitiesForPeople(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date },
  ): Promise<number> {
    if (hasDateWindow(options)) {
      const userId = ownerUserId(context.userId);
      if (userId == null) {
        return 0;
      }

      const rows = await this.repository.manager.query<Array<{ n: number }>>(
        personAppearanceCountSql(),
        appearanceWindowParams(userId, options),
      );

      return Number(rows[0]?.n ?? 0);
    }

    let query = this.repository
      .createQueryBuilder('person')
      .where('person.owner_user_id = :userId', { userId: context.userId })
      .andWhere('person.is_active IS DISTINCT FROM FALSE')
      .andWhere('person.merged_into_entity_id IS NULL');

    if (options.startTime) {
      query = query.andWhere('person.updated_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('person.updated_at <= :endTime', { endTime: options.endTime });
    }

    return query.getCount();
  }

  /**
   * @param options.source Who is writing, for Change History (`change_source`):
   *   the syncs and background writers that come through here name themselves,
   *   e.g. `TransformGoogleContacts.processContact`.
   */
  async update(
    context: ServiceContext,
    id: string,
    data: UpdatePersonDto,
    options: { source?: string } = {},
  ): Promise<Person | null> {
    const { properties, ...rest } = data;
    let beforeRow = null as PersonEntity | null;

    const after = await this.applyUpdate(context, id, (before) => {
      beforeRow = before;
      const stored = (before.properties ?? {}) as Record<string, unknown>;
      // What a person set in Edit Person (`patch` with `handEdit`) outranks the
      // syncs and background writers that come through here (Google and
      // Facebook contacts, memory compaction): their value for a hand-set key,
      // or a hand-set name or description, is dropped, as an import's is.
      const handSet = new Set(userEditedKeys(stored));
      // Written back as stored rather than left out, so a name-only update of a
      // hand-named person is still a (no-op) write and not an empty one.
      const columns = {
        ...rest,
        ...(handSet.has('name') && rest.name !== undefined ? { name: before.name } : {}),
        ...(handSet.has('description') && rest.description !== undefined
          ? { description: before.description }
          : {}),
      };

      if (!properties) {
        return columns;
      }

      // Callers routinely round-trip an egress bag, and toEgressType strips
      // the normalized keys from it (they live on the named fields instead).
      // An absent normalized key therefore means "unchanged", not "cleared":
      // carry the stored value over, and only sync a typed column when its
      // storage key is explicitly present in the incoming bag.
      const merged: Record<string, unknown> = { ...properties };
      for (const [storageKey] of NORMALIZED_PERSON_FIELDS) {
        if (!(storageKey in properties) && storageKey in stored) {
          merged[storageKey] = stored[storageKey];
        }
      }

      for (const key of handSet) {
        if (key in stored) {
          merged[key] = stored[key];
        } else {
          delete merged[key];
        }
      }

      // The list is only ever written by a hand edit, never taken from a caller's bag.
      if (USER_EDITED_KEYS in stored) {
        merged[USER_EDITED_KEYS] = stored[USER_EDITED_KEYS];
      } else {
        delete merged[USER_EDITED_KEYS];
      }

      const typedAll = typedColumnsFromProperties(properties);
      const typed: {
        firstName?: string | null;
        middleName?: string | null;
        lastName?: string | null;
        birthDate?: string | null;
        isSelf?: boolean;
      } = {};

      if ('first_name' in properties && !handSet.has('first_name')) {
        typed.firstName = typedAll.firstName;
      }

      if ('middle_name' in properties && !handSet.has('middle_name')) {
        typed.middleName = typedAll.middleName;
      }

      if ('last_name' in properties && !handSet.has('last_name')) {
        typed.lastName = typedAll.lastName;
      }

      if ('birth_date' in properties && !handSet.has('birth_date')) {
        typed.birthDate = typedAll.birthDate;
      }

      if (typedAll.isSelf !== undefined) {
        typed.isSelf = typedAll.isSelf;
      }

      return {
        ...columns,
        ...typed,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: merged as any, // TypeORM will handle JSON serialization
      };
    });

    if (!after) {
      return null;
    }

    if (beforeRow) {
      await this.recordUpdate(context, beforeRow, after, options.source ?? 'PersonService.update');
    }

    await this.eventService.send(PersonUpdatedEvent, {
      personId: id,
    });

    return PersonEntity.toEgressType(after);
  }

  /**
   * One Change History row for an {@link update}: name, description and every
   * property key whose value moved between the row as it was and as it is now.
   * A sync that writes the same bag back records nothing, sync stamps aside
   * (see {@link withoutSyncStamps}).
   */
  private async recordUpdate(
    context: ServiceContext,
    before: PersonEntity,
    after: PersonEntity,
    source: string,
  ): Promise<void> {
    const was = withoutSyncStamps(before.properties ?? {}) as Record<string, unknown>;
    const now = withoutSyncStamps(after.properties ?? {}) as Record<string, unknown>;
    const changedFields = {
      ...changedFieldsBetween(
        { name: before.name, description: before.description },
        { name: after.name, description: after.description },
        ['name', 'description'],
      ),
      ...changedFieldsBetween(was, now, new Set([...Object.keys(was), ...Object.keys(now)])),
    };

    if (Object.keys(changedFields).length === 0) {
      return;
    }

    await this.graphDeltaWriter?.entityUpdated({
      entityId: after.id,
      entityType: 'Person',
      name: after.name,
      changedFields,
      ownerUserId: after.userId ?? null,
      changeSource: source,
      changedByUserId: typeof context.userId === 'string' ? context.userId : null,
    });
  }

  /**
   * Partial update for the structured-person editor: merges `propertiesPatch`
   * into the existing properties JSONB (single-statement `properties || patch`,
   * so concurrent patches to different keys don't clobber each other) and
   * updates name/description only when provided. A patch key set to null
   * clears that property.
   *
   * `handEdit` is the Edit Person form saving: every key whose value this
   * statement changes or clears (and `name` / `description`, when they change)
   * is added to `properties.user_edited_keys`, and a later import or sync leaves
   * those alone (`USER_EDITED_KEYS` in graph/utils/ingestedProperties.ts, and
   * {@link update}). The form sends every field back on each save, so the
   * comparison is with the stored value, in the same statement: an unchanged
   * field is not claimed.
   */
  async patch(
    context: ServiceContext,
    id: string,
    data: { name?: string; description?: string; propertiesPatch?: Record<string, unknown> },
    options: { handEdit?: boolean } = {},
  ): Promise<Person | null> {
    const set: Record<string, unknown> = {};
    if (data.name !== undefined) {
      set.name = data.name;
    }

    if (data.description !== undefined) {
      set.description = data.description;
    }

    const hasPatch = data.propertiesPatch != null && Object.keys(data.propertiesPatch).length > 0;
    const claimsColumn =
      options.handEdit === true && (data.name !== undefined || data.description !== undefined);

    if (hasPatch || claimsColumn) {
      set.properties = options.handEdit
        ? () => `(COALESCE(properties, '{}'::jsonb) || :propertiesPatch::jsonb) || ${handEditedKeysSql(data)}`
        : () => `properties || :propertiesPatch::jsonb`;
    }

    if (hasPatch && data.propertiesPatch) {
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

    // What the row held, so Change History can say what this edit changed.
    const before = this.graphDeltaWriter
      ? await this.repository.findOne({ where: { id, ...this.scopeToUser(context) } })
      : null;

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
      qb = qb.setParameter('propertiesPatch', JSON.stringify(data.propertiesPatch ?? {}));
    }

    if (options.handEdit && data.name !== undefined) {
      qb = qb.setParameter('editedName', data.name);
    }

    if (options.handEdit && data.description !== undefined) {
      qb = qb.setParameter('editedDescription', data.description);
    }

    const result = await qb.execute();

    if ((result.affected ?? 0) === 0) {
      return null;
    }

    if (before) {
      await this.recordPatch(context, before, data);
    }

    await this.eventService.send(PersonUpdatedEvent, {
      personId: id,
    });

    return this.findById(context, id);
  }

  /**
   * One Change History row for a {@link patch}, holding only the fields whose
   * value moved. The Edit Person form sends every field back, changed or not,
   * so the patch itself is not the change.
   */
  private async recordPatch(
    context: ServiceContext,
    before: PersonEntity,
    data: { name?: string; description?: string; propertiesPatch?: Record<string, unknown> },
  ): Promise<void> {
    const patchKeys = Object.keys(data.propertiesPatch ?? {});
    // `!== undefined`, not `??`: an explicit null is a clear that `patch` writes.
    const name = data.name !== undefined ? data.name : before.name;
    const description = data.description !== undefined ? data.description : before.description;
    const changedFields = {
      ...changedFieldsBetween({ name: before.name, description: before.description }, { name, description }, [
        'name',
        'description',
      ]),
      ...changedFieldsBetween(before.properties ?? {}, data.propertiesPatch ?? {}, patchKeys),
    };

    if (Object.keys(changedFields).length === 0) {
      return;
    }

    await this.graphDeltaWriter?.entityUpdated({
      entityId: before.id,
      entityType: 'Person',
      name,
      changedFields,
      ownerUserId: before.userId,
      changeSource: 'PersonService.patch',
      changedByUserId: typeof context.userId === 'string' ? context.userId : null,
    });
  }

  /**
   * Patch individual *leaves* of the properties JSONB.
   *
   * `patch()` merges at the top level only (`properties || patch`), so a caller
   * that wants to change one key inside a sub-object has to read the whole
   * sub-object, spread it, and send it back — a read-modify-write that loses the
   * other writer's update whenever two of them touch different leaves of the
   * same sub-object (e.g. `planner.trust_mode` vs
   * `planner.image_description_enabled`).
   *
   * This writes each leaf with `jsonb_set(..., '{a,b}', value, true)` in a single
   * statement, reading nothing in the application, so concurrent writers to
   * different leaves cannot clobber each other.
   *
   * Paths must be at least two segments deep — top-level keys go through
   * `patch()`, which also keeps the typed identity columns in sync.
   */
  async patchPropertyLeaves(
    context: ServiceContext,
    id: string,
    leaves: JsonbLeafPatch[],
  ): Promise<Person | null> {
    if (leaves.length === 0) {
      return this.findById(context, id);
    }

    const { expression, parameters } = buildJsonbLeafPatchSql('properties', leaves);

    let qb = this.repository
      .createQueryBuilder()
      .update()
      .set({ properties: () => expression })
      .where('entity_id = :id', { id })
      .andWhere(`entity_type = 'Person'`);

    if (context.userId !== SYSTEM_USER) {
      qb = qb.andWhere('owner_user_id = :userId', { userId: context.userId });
    }

    for (const [name, value] of Object.entries(parameters)) {
      qb = qb.setParameter(name, value);
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

  /**
   * Permanently deletes people, with everything that only exists because of them.
   * This is `memory.forget`'s `archive_and_delete` for a `Person` node, and the
   * other end from {@link remove}: see {@link purgePersonAggregates} for what goes,
   * for what is remembered so the person is not created again from mail that still
   * names them, and for the user's own node, which is refused.
   *
   * The duplicates that were merged into a person go with them, and are named in
   * the result separately because nobody asked for them.
   *
   * Everything is one transaction. Search is told afterwards, once for every person
   * that went, and the ids that were not the caller's, or no longer exist, are
   * simply left out of the result.
   */
  async purge(context: UserServiceContext, ids: string[]): Promise<PurgedPeople> {
    const requested = Array.from(new Set(ids));

    if (requested.length === 0) {
      return { personIds: [], duplicateIds: [], blockedIdentifiers: 0 };
    }

    const purged = await this.repository.manager.transaction((manager) =>
      purgePersonAggregates(manager, context.userId, requested),
    );

    // The index rows were deleted in the transaction. This tells anything else
    // that listens, and is what announces a removal everywhere else in the app.
    for (const personId of [...purged.personIds, ...purged.duplicateIds]) {
      await this.eventService.send(PersonRemovedEvent, { personId });
    }

    return purged;
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
