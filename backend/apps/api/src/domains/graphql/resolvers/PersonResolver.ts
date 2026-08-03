import { UseGuards } from '@nestjs/common';
import { Mutation, Parent, Query, ResolveField, Resolver, Args, ID, Int } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { EntityIdentifierService, type IdentifierKind } from '@ci/domains/graph';
import { CreatePersonPayload } from '@ci/domains/graphql/types/CreatePersonPayload';
import { DeleteByIdInput } from '@ci/domains/graphql/types/DeleteByIdInput';
import { DeleteByIdPayload } from '@ci/domains/graphql/types/DeleteByIdPayload';
import { PersonDuplicateService, PersonService } from '@ci/domains/memory';
import {
  PeoplePromotionService,
  PeopleService,
  PersonDuplicateSuggestionService,
  PersonMergeService,
  USER_EDITED_FIELDS_KEY,
} from '@ci/domains/people';

import { PersonIdentifiersLoader } from '../loaders/PersonIdentifiersLoader';
import { PersonInteractionStatsLoader } from '../loaders/PersonInteractionStatsLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CreatePersonInput } from '../types/CreatePersonInput';
import { DetachPersonProfileInput } from '../types/DetachPersonProfileInput';
import { DetachPersonProfilePayload } from '../types/DetachPersonProfilePayload';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { MergePeopleInput } from '../types/MergePeopleInput';
import { MergePeoplePayload } from '../types/MergePeoplePayload';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonDuplicateGroupType } from '../types/PersonDuplicateGroupType';
import { PersonDuplicateSuggestionType } from '../types/PersonDuplicateSuggestionType';
import { PersonEdge } from '../types/PersonEdge';
import { AddPersonIdentifierInput, RemovePersonIdentifierInput } from '../types/PersonIdentifierInput';
import { PersonIdentifierType } from '../types/PersonIdentifierType';
import { PersonInteractionStatsType } from '../types/PersonInteractionStatsType';
import { PersonProfileType } from '../types/PersonProfileType';
import { PersonType } from '../types/PersonType';
import { RejectPersonDuplicateSuggestionPayload } from '../types/RejectPersonDuplicateSuggestionPayload';
import { UpdatePersonInput } from '../types/UpdatePersonInput';
import { UpdatePersonPayload } from '../types/UpdatePersonPayload';
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
    private readonly personDuplicateService: PersonDuplicateService,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly personIdentifiersLoader: PersonIdentifiersLoader,
    private readonly personInteractionStatsLoader: PersonInteractionStatsLoader,
    private readonly peopleService: PeopleService,
    private readonly personMergeService: PersonMergeService,
    private readonly peoplePromotionService: PeoplePromotionService,
    private readonly suggestionService: PersonDuplicateSuggestionService,
    private readonly tagLoader: TagLoader,
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

    const propertiesPatch = structuredPropertiesPatch(input);

    // Record which fields the user explicitly edited so merges never let a
    // source value overwrite them (PersonMergeService gives these precedence).
    const editedFields = [
      ...(input.name !== undefined ? ['name'] : []),
      ...(input.description !== undefined ? ['description'] : []),
      ...Object.keys(propertiesPatch),
    ];

    if (editedFields.length > 0) {
      const current = await this.personService.findById(serviceContext, id);
      const currentEdited = Array.isArray(current?.properties?.[USER_EDITED_FIELDS_KEY])
        ? (current.properties[USER_EDITED_FIELDS_KEY] as unknown[]).filter(
            (v): v is string => typeof v === 'string',
          )
        : [];
      propertiesPatch[USER_EDITED_FIELDS_KEY] = [...new Set([...currentEdited, ...editedFields])];
    }

    const entity = await this.personService.patch(serviceContext, id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      propertiesPatch,
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

  /**
   * Detach a source profile onto a fresh person ("that Discord account is NOT
   * this Liam"). Writes sticky distinctions so automation never re-attaches
   * the profile or re-merges the pair.
   */
  @Mutation(() => DetachPersonProfilePayload)
  async detachPersonProfile(
    @Context() context: RequestContext,
    @Args('input') input: DetachPersonProfileInput,
  ): Promise<DetachPersonProfilePayload> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { success: false };
    }

    const detached = await this.peoplePromotionService.detachProfile({ userId }, input.profileId);
    if (detached == null) {
      return { success: false };
    }

    const person = await this.personService.findById(serviceContext, detached.personEntityId);

    return {
      success: true,
      person: person ? PersonType.toType(person) : undefined,
    };
  }

  /** Pending weak-signal duplicate suggestions, highest confidence first. */
  @Query(() => [PersonDuplicateSuggestionType])
  async personDuplicateSuggestions(
    @Context() context: RequestContext,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<PersonDuplicateSuggestionType[]> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return [];
    }

    const { suggestions } = await this.suggestionService.listPending(userId, {
      limit: limit ?? undefined,
      offset: offset ?? undefined,
    });

    return Promise.all(
      suggestions.map(async (suggestion) => {
        const [personA, personB] = await Promise.all([
          this.personService.findById(serviceContext, suggestion.entityIdA),
          this.personService.findById(serviceContext, suggestion.entityIdB),
        ]);

        return {
          id: suggestion.id,
          personA: personA ? PersonType.toType(personA) : null,
          personB: personB ? PersonType.toType(personB) : null,
          confidence: Number(suggestion.confidence),
          signals: JSON.stringify(suggestion.signals ?? {}),
          status: suggestion.status,
          createdAt: suggestion.createdAt,
        };
      }),
    );
  }

  /** Confirm a duplicate suggestion — merges person B into person A. */
  @Mutation(() => MergePeoplePayload)
  async acceptPersonDuplicateSuggestion(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<MergePeoplePayload> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { success: false };
    }

    const survivorId = await this.suggestionService.accept({ userId }, id);
    if (survivorId == null) {
      return { success: false };
    }

    const survivor = await this.personService.findById(serviceContext, survivorId);

    return {
      success: true,
      person: survivor ? PersonType.toType(survivor) : undefined,
    };
  }

  /**
   * Dismiss a duplicate suggestion — records a sticky "not the same person"
   * distinction so the pair is never suggested or auto-merged again.
   */
  @Mutation(() => RejectPersonDuplicateSuggestionPayload)
  async rejectPersonDuplicateSuggestion(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<RejectPersonDuplicateSuggestionPayload> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { success: false };
    }

    const success = await this.suggestionService.reject({ userId }, id);

    return { success };
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
   * Merge duplicate people into one canonical person: re-points profiles,
   * identifiers, communications, events and graph edges, folds properties
   * (user-edited fields win), tombstones the sources and writes audit rows.
   * Explicit user action — overrides any recorded "not the same person"
   * distinction for the pairs. See the people domain's PersonMergeService.
   */
  @Mutation(() => MergePeoplePayload)
  async mergePeople(
    @Context() context: RequestContext,
    @Args('input') input: MergePeopleInput,
  ): Promise<MergePeoplePayload> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { success: false };
    }

    const sourceIds = input.sourceIds.map((gid) => GlobalUID.parse('person', gid));
    const targetId = GlobalUID.parse('person', input.targetId);

    let survivorId = targetId;
    let anyMerged = false;
    for (const sourceId of sourceIds) {
      const result = await this.personMergeService.merge(userId, survivorId, sourceId, {
        initiator: 'user',
      });
      survivorId = result.winnerEntityId;
      anyMerged = anyMerged || result.merged;
    }

    const survivor = await this.personService.findById(serviceContext, survivorId);

    return {
      success: anyMerged,
      person: survivor ? PersonType.toType(survivor) : undefined,
    };
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
    if (kind != null) {
      await this.entityIdentifierService.addForEntity(
        serviceContext.userId,
        personId,
        kind,
        input.value,
        input.label,
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
    if (kind != null) {
      await this.entityIdentifierService.removeForEntity(serviceContext.userId, personId, kind, input.value);
    }

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

    // Tombstone-following: an id merged away resolves to its survivor (the
    // returned node carries the SURVIVOR's id, so clients see the redirect).
    if (typeof serviceContext.userId === 'string') {
      const resolved = await this.peopleService.findByIdFollowingTombstone(
        { userId: serviceContext.userId },
        id,
      );

      return resolved ? PersonType.toType(resolved.person) : null;
    }

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

  /** The person's source profiles ("what Discord knows", "what Google knows"), oldest first. */
  @ResolveField(() => [PersonProfileType])
  async profiles(
    @Context() context: RequestContext,
    @Parent() parent: PersonType,
  ): Promise<PersonProfileType[]> {
    const serviceContext = toServiceContext(context);
    if (typeof serviceContext.userId !== 'string') {
      return [];
    }

    const profiles = await this.peopleService.getProfilesForPerson(
      serviceContext.userId,
      parent.__source.id,
    );

    return profiles.map((profile) => PersonProfileType.toType(profile));
  }

  /** Deduped emails across the person's identifier index rows and profiles. */
  @ResolveField(() => [String])
  async emails(@Context() context: RequestContext, @Parent() parent: PersonType): Promise<string[]> {
    const serviceContext = toServiceContext(context);
    if (typeof serviceContext.userId !== 'string') {
      return [];
    }

    const identifiers = await this.peopleService.getIdentifiersForPerson(
      serviceContext.userId,
      parent.__source.id,
    );

    return identifiers.emails;
  }

  /** Deduped phone numbers across the person's identifier index rows and profiles. */
  @ResolveField(() => [String])
  async phones(@Context() context: RequestContext, @Parent() parent: PersonType): Promise<string[]> {
    const serviceContext = toServiceContext(context);
    if (typeof serviceContext.userId !== 'string') {
      return [];
    }

    const identifiers = await this.peopleService.getIdentifiersForPerson(
      serviceContext.userId,
      parent.__source.id,
    );

    return identifiers.phones;
  }

  private async entityIdentifiersFor(
    serviceContext: ReturnType<typeof toServiceContext>,
    personId: string,
  ): Promise<PersonIdentifierType[]> {
    const byEntity = await this.entityIdentifierService.listForEntities(serviceContext.userId, [personId]);

    return (byEntity.get(personId) ?? []).map((row) => PersonIdentifierType.toType(row));
  }
}
