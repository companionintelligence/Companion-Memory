import { BadRequestException, ConflictException, UseGuards } from '@nestjs/common';
import { Mutation, Parent, Query, ResolveField, Resolver, Args, ID, Int } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { EntityIdentifierService, type IdentifierKind } from '@ci/domains/graph';
import { CreatePersonPayload } from '@ci/domains/graphql/types/CreatePersonPayload';
import { DeleteByIdInput } from '@ci/domains/graphql/types/DeleteByIdInput';
import { DeleteByIdPayload } from '@ci/domains/graphql/types/DeleteByIdPayload';
import {
  EntityMergeBlockService,
  GraphQueryService,
  PersonDuplicateService,
  PersonMergeService,
  PersonService,
} from '@ci/domains/memory';

import { PersonIdentifiersLoader } from '../loaders/PersonIdentifiersLoader';
import { PersonInteractionStatsLoader } from '../loaders/PersonInteractionStatsLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CreatePersonInput } from '../types/CreatePersonInput';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { MergePeopleInput } from '../types/MergePeopleInput';
import { MergePeoplePayload } from '../types/MergePeoplePayload';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonDuplicateGroupType } from '../types/PersonDuplicateGroupType';
import { PersonEdge } from '../types/PersonEdge';
import { AddPersonIdentifierInput, RemovePersonIdentifierInput } from '../types/PersonIdentifierInput';
import { PersonIdentifierType } from '../types/PersonIdentifierType';
import { PersonInteractionStatsType } from '../types/PersonInteractionStatsType';
import { PersonType } from '../types/PersonType';
import { RelationshipType } from '../types/RelationshipType';
import { UpdatePersonInput } from '../types/UpdatePersonInput';
import { UpdatePersonPayload } from '../types/UpdatePersonPayload';
import { memoryRelToGql } from '../utils/lifeGraphRelationships';
import { Paginator } from '../utils/Paginator';

/** Map the structured input fields onto the established properties JSONB keys. */
function structuredPropertiesPatch(
  input: Partial<CreatePersonInput> | Partial<UpdatePersonInput>,
): Record<string, unknown> {
  const mapping: Array<[keyof CreatePersonInput & keyof UpdatePersonInput, string]> = [
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['lastName', 'last_name'],
    ['gender', 'gender'],
    ['birthDate', 'birth_date'],
    ['streetAddress', 'street_address'],
    ['streetAddress2', 'street_address_2'],
    ['city', 'city'],
    ['region', 'region'],
    ['country', 'country'],
    ['postalCode', 'postal_code'],
    ['avatarUrl', 'avatar_url'],
  ];

  const patch: Record<string, unknown> = {};
  for (const [field, key] of mapping) {
    const value = (input as Record<string, unknown>)[field];
    if (value !== undefined) {
      // An explicit empty string clears the property.
      patch[key] = typeof value === 'string' && value.trim() === '' ? null : value;
    }
  }

  return patch;
}

const IDENTIFIER_KINDS: IdentifierKind[] = ['email', 'phone', 'name'];

function parseIdentifierKind(raw: string): IdentifierKind | null {
  return (IDENTIFIER_KINDS as string[]).includes(raw) ? (raw as IdentifierKind) : null;
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => PersonType)
export class PersonResolver {
  constructor(
    private readonly personService: PersonService,
    private readonly personMergeService: PersonMergeService,
    private readonly personDuplicateService: PersonDuplicateService,
    private readonly entityMergeBlockService: EntityMergeBlockService,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly personIdentifiersLoader: PersonIdentifiersLoader,
    private readonly personInteractionStatsLoader: PersonInteractionStatsLoader,
    private readonly tagLoader: TagLoader,
    private readonly graphQuery: GraphQueryService,
  ) {}

  @Mutation(() => CreatePersonPayload)
  async createPerson(
    @Context() context: RequestContext,
    @Args('input') input: CreatePersonInput,
  ): Promise<CreatePersonPayload> {
    const serviceContext = toServiceContext(context);

    const properties = structuredPropertiesPatch(input);
    if (input.emails?.length) {
      properties.emails = input.emails;
    }

    if (input.phones?.length) {
      properties.phones = input.phones;
    }

    const entity = await this.personService.create(serviceContext, {
      name: input.name,
      description: input.description,
      linkedTable: input.linkedTable,
      linkedId: input.linkedId,
      properties,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    // Register the initial contact methods so the new person resolves in
    // people-linking immediately (non-fatal, same as ingest).
    if (input.emails?.length || input.phones?.length) {
      await this.entityIdentifierService
        .upsertForEntity(serviceContext.userId, entity.id, {
          emails: input.emails,
          phones: input.phones,
        })
        .catch(() => undefined);
    }

    return {
      success: true,
      person: entity ? PersonType.toType(entity) : undefined,
    };
  }

  /**
   * Batch create people in one round-trip. Each input resolves-or-creates on the
   * (linkedTable, linkedId) provenance key, so a re-sync returns the existing
   * person instead of duplicating it. Returns the created-or-existing people in
   * input order — the clean batch equivalent of N createPerson mutations.
   */
  @Mutation(() => [PersonType])
  async createPeople(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreatePersonInput] }, new MaxArraySizePipe())
    input: CreatePersonInput[],
  ): Promise<PersonType[]> {
    const serviceContext = toServiceContext(context);

    const people = await this.personService.createMany(
      serviceContext,
      input.map((item) => ({
        name: item.name,
        description: item.description,
        linkedTable: item.linkedTable,
        linkedId: item.linkedId,
        properties: {
          ...structuredPropertiesPatch(item),
          ...(item.emails?.length ? { emails: item.emails } : {}),
          ...(item.phones?.length ? { phones: item.phones } : {}),
        },
      })),
    );

    return people.map((person) => PersonType.toType(person));
  }

  @Mutation(() => UpdatePersonPayload)
  async updatePerson(
    @Context() context: RequestContext,
    @Args('input') input: UpdatePersonInput,
  ): Promise<UpdatePersonPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('person', input.id);

    const entity = await this.personService.patch(serviceContext, id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      propertiesPatch: structuredPropertiesPatch(input),
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      person: entity ? PersonType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deletePerson(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('person', input.id);

    const success = await this.personService.remove(serviceContext, id);

    if (!success) {
      return {
        success: false,
      };
    }

    return {
      success,
      deletedId: input.id,
    };
  }

  /**
   * Merge duplicate people into one canonical person: re-points identifiers,
   * communications, events and graph edges, folds properties, and tombstones
   * the sources. See PersonMergeService.
   */
  @Mutation(() => MergePeoplePayload)
  async mergePeople(
    @Context() context: RequestContext,
    @Args('input') input: MergePeopleInput,
  ): Promise<MergePeoplePayload> {
    const serviceContext = toServiceContext(context);

    const sourceIds = input.sourceIds.map((gid) => GlobalUID.parse('person', gid));
    const targetId = GlobalUID.parse('person', input.targetId);

    const person = await this.personMergeService.mergePeople(serviceContext, sourceIds, targetId);

    return {
      success: true,
      person: PersonType.toType(person),
    };
  }

  /**
   * Record that a suggested duplicate group is NOT the same person.
   *
   * The counterpart to mergePeople, and the reason duplicate detection can
   * afford to be derived: without somewhere to put the rejection, "no, those
   * are two different people" would survive only until the next page load.
   * Every pair in the group is blocked, because the group is what was offered.
   */
  @Mutation(() => Boolean, {
    description: 'Mark a suggested duplicate group as distinct people, so it is never re-proposed',
  })
  async rejectPersonDuplicates(
    @Context() context: RequestContext,
    @Args('personIds', { type: () => [ID] }) personIds: string[],
  ): Promise<boolean> {
    const ids = personIds.map((gid) => GlobalUID.parse('person', gid));

    await this.entityMergeBlockService.blockAllPairs(toServiceContext(context), ids, 'user_rejected');

    return true;
  }

  /** Add a contact method / identifier to a person (source='user'). */
  @Mutation(() => [PersonIdentifierType])
  async addPersonIdentifier(
    @Context() context: RequestContext,
    @Args('input') input: AddPersonIdentifierInput,
  ): Promise<PersonIdentifierType[]> {
    const serviceContext = toServiceContext(context);

    const personId = GlobalUID.parse('person', input.personId);
    const kind = parseIdentifierKind(input.kind);
    if (kind == null) {
      throw new BadRequestException(
        `Unknown identifier kind "${input.kind}" — expected email, phone, or name`,
      );
    }

    const owningEntityId = await this.entityIdentifierService.addForEntity(
      serviceContext.userId,
      personId,
      kind,
      input.value,
      input.label,
    );

    if (owningEntityId == null) {
      throw new BadRequestException(`"${input.value}" does not normalize to a usable ${kind}`);
    }

    if (owningEntityId !== personId) {
      // First-writer-wins: the tuple already belongs to another entity and the
      // claim was deliberately NOT stolen. Surface it — the right fix is a
      // merge, not a silent re-point.
      throw new ConflictException(
        'That identifier already belongs to another person. Merge the two people instead of re-assigning it.',
      );
    }

    this.personIdentifiersLoader.clear(serviceContext, personId);

    const rows = await this.entityIdentifiersFor(serviceContext, personId);

    return rows;
  }

  /** Remove a contact method / identifier from a person. */
  @Mutation(() => [PersonIdentifierType])
  async removePersonIdentifier(
    @Context() context: RequestContext,
    @Args('input') input: RemovePersonIdentifierInput,
  ): Promise<PersonIdentifierType[]> {
    const serviceContext = toServiceContext(context);

    const personId = GlobalUID.parse('person', input.personId);
    const kind = parseIdentifierKind(input.kind);
    if (kind == null) {
      throw new BadRequestException(
        `Unknown identifier kind "${input.kind}" — expected email, phone, or name`,
      );
    }

    await this.entityIdentifierService.removeForEntity(serviceContext.userId, personId, kind, input.value);

    this.personIdentifiersLoader.clear(serviceContext, personId);

    return this.entityIdentifiersFor(serviceContext, personId);
  }

  @Query(() => PersonConnection)
  async people(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
    @Args('query', { type: () => String, nullable: true }) query?: string,
  ): Promise<PersonConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.personService.findAll(serviceContext, { query: query ?? undefined });

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('person', entity.id),
    });

    const edges: PersonEdge[] = slice.map((entity) => {
      const node = PersonType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Query(() => PersonType, { nullable: true })
  async person(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<PersonType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('person', gid);

    const entity = await this.personService.findById(serviceContext, id);

    return entity ? PersonType.toType(entity) : null;
  }

  /**
   * Duplicate-person suggestions for the merge review UI: groups of live
   * people sharing a normalized email, phone, or display name.
   */
  @Query(() => [PersonDuplicateGroupType])
  async personDuplicates(
    @Context() context: RequestContext,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<PersonDuplicateGroupType[]> {
    const serviceContext = toServiceContext(context);

    const groups = await this.personDuplicateService.findDuplicateGroups(serviceContext, {
      limit: limit ?? undefined,
    });

    return groups.map((group) => ({
      reason: group.reason,
      value: group.value,
      people: group.people.map((person) => PersonType.toType(person)),
    }));
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: PersonType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'person',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }

  /** Contact methods / identifiers claimed by this person. */
  @ResolveField(() => [PersonIdentifierType])
  async identifiers(
    @Context() context: RequestContext,
    @Parent() parent: PersonType,
  ): Promise<PersonIdentifierType[]> {
    const serviceContext = toServiceContext(context);

    const rows = await this.personIdentifiersLoader.load(serviceContext, parent.__source.id);

    return rows.map((row) => PersonIdentifierType.toType(row));
  }

  /** Event/communication activity aggregates for this person. */
  @ResolveField(() => PersonInteractionStatsType)
  async interactionStats(
    @Context() context: RequestContext,
    @Parent() parent: PersonType,
  ): Promise<PersonInteractionStatsType> {
    const serviceContext = toServiceContext(context);

    const stats = await this.personInteractionStatsLoader.load(serviceContext, parent.__source.id);

    return PersonInteractionStatsType.toType(stats);
  }

  /** Outbound life-graph edges from this person (L0/L1/L2 in ci.relationships). */
  @ResolveField(() => [RelationshipType])
  async outgoingRelationships(
    @Context() context: RequestContext,
    @Parent() parent: PersonType,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<RelationshipType[]> {
    const serviceContext = toServiceContext(context);
    if (typeof serviceContext.userId !== 'string') {
      return [];
    }

    const rows = await this.graphQuery.getRelationships(serviceContext.userId, {
      entityIds: [parent.__source.id],
      direction: 'outbound',
    });

    return rows.slice(0, limit ?? 50).map((row) => memoryRelToGql(row));
  }

  /** Inbound life-graph edges to this person. */
  @ResolveField(() => [RelationshipType])
  async incomingRelationships(
    @Context() context: RequestContext,
    @Parent() parent: PersonType,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<RelationshipType[]> {
    const serviceContext = toServiceContext(context);
    if (typeof serviceContext.userId !== 'string') {
      return [];
    }

    const rows = await this.graphQuery.getRelationships(serviceContext.userId, {
      entityIds: [parent.__source.id],
      direction: 'inbound',
    });

    return rows.slice(0, limit ?? 50).map((row) => memoryRelToGql(row));
  }

  private async entityIdentifiersFor(
    serviceContext: ReturnType<typeof toServiceContext>,
    personId: string,
  ): Promise<PersonIdentifierType[]> {
    const byEntity = await this.entityIdentifierService.listForEntities(serviceContext.userId, [personId]);

    return (byEntity.get(personId) ?? []).map((row) => PersonIdentifierType.toType(row));
  }
}
