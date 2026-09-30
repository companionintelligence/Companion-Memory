import { BadRequestException, ConflictException, UseGuards } from '@nestjs/common';
import { Mutation, Parent, Query, ResolveField, Resolver, Args, ID, Int } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { JobControlStore } from '@ci/common/job-controls';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { EntityIdentifierService, type IdentifierKind } from '@ci/domains/graph';
import { CreatePersonPayload } from '@ci/domains/graphql/types/CreatePersonPayload';
import { DeleteByIdInput } from '@ci/domains/graphql/types/DeleteByIdInput';
import { DeleteByIdPayload } from '@ci/domains/graphql/types/DeleteByIdPayload';
import {
  type DuplicateReason,
  type MergeCandidateStatus,
  type PersonAddress,
  DETERMINISTIC_MERGE_CRON,
  encodeMergeCandidateCursor,
  EntityMergeBlockService,
  GraphQueryService,
  isMergeCandidateStatus,
  MergeCandidateService,
  PersonDuplicateService,
  PersonMergeService,
  PersonService,
  ensureSinglePrimary,
  formatPersonAddress,
  isPersonAddressEmpty,
  serializePersonAddress,
} from '@ci/domains/memory';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { PersonIdentifiersLoader } from '../loaders/PersonIdentifiersLoader';
import { PersonInteractionStatsLoader } from '../loaders/PersonInteractionStatsLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CreatePersonInput } from '../types/CreatePersonInput';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { MergeCandidateConnection } from '../types/MergeCandidateConnection';
import { MergeCandidateType } from '../types/MergeCandidateType';
import { MergePeopleInput } from '../types/MergePeopleInput';
import { MergePeoplePayload } from '../types/MergePeoplePayload';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonAddressInput } from '../types/PersonAddressType';
import { PersonConnection } from '../types/PersonConnection';
import { PersonContactInput } from '../types/PersonContactInput';
import { PersonDuplicatesPayload } from '../types/PersonDuplicatesPayload';
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
import {
  contactMethodsFromPersonProperties,
  contactsToReconcile,
  droppedContactsPatch,
  mergePersonIdentifiers,
  removedContactPatch,
} from '../utils/personContactMethods';

/** How long the review-queue query may spend folding deterministic pairs before it answers. */
const ON_READ_FOLD_BUDGET_MS = 5_000;

/**
 * How long the review-queue query may spend re-checking stored phone evidence
 * against the live records (`MergeCandidateService.revalidatePhoneEvidence`).
 * Three small indexed statements per 100 pending phone pairs and no corpus
 * read — about 25 ms for 200 pairs over 17k people, measured 2026-09-29. The
 * budget bounds a pathological queue, not the ordinary one.
 */
const ON_READ_PHONE_RECHECK_BUDGET_MS = 3_000;

/** Map the structured input fields onto the established properties JSONB keys. */
function structuredPropertiesPatch(
  input: Partial<CreatePersonInput> | Partial<UpdatePersonInput>,
): Record<string, unknown> {
  const mapping: Array<[keyof CreatePersonInput & keyof UpdatePersonInput, string]> = [
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['lastName', 'last_name'],
    ['nickname', 'nickname'],
    ['pronouns', 'pronouns'],
    ['gender', 'gender'],
    ['birthDate', 'birth_date'],
    ['jobTitle', 'job_title'],
    ['organization', 'organization'],
    ['department', 'department'],
    ['website', 'website'],
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

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function toPersonAddress(input: PersonAddressInput): PersonAddress {
  return {
    label: trimmedOrNull(input.label),
    streetAddress: trimmedOrNull(input.streetAddress),
    streetAddress2: trimmedOrNull(input.streetAddress2),
    city: trimmedOrNull(input.city),
    region: trimmedOrNull(input.region),
    postalCode: trimmedOrNull(input.postalCode),
    country: trimmedOrNull(input.country),
    isPrimary: input.isPrimary === true,
  };
}

/**
 * Turn the address list into its properties patch.
 *
 * The list is canonical, but the flat `street_address`/`city`/... keys are the
 * only address a pre-list reader (the search projection, older importers)
 * understands — so the primary address is mirrored onto them, and blank rows
 * are dropped rather than persisted as an empty address.
 */
function addressPropertiesPatch(addresses: PersonAddressInput[]): Record<string, unknown> {
  const parsed = ensureSinglePrimary(addresses.map(toPersonAddress).filter((a) => !isPersonAddressEmpty(a)));
  const primary = parsed[0] ?? null;

  return {
    addresses: parsed.map((address) => serializePersonAddress(address)),
    address: primary ? formatPersonAddress(primary) : null,
    street_address: primary?.streetAddress ?? null,
    street_address_2: primary?.streetAddress2 ?? null,
    city: primary?.city ?? null,
    region: primary?.region ?? null,
    postal_code: primary?.postalCode ?? null,
    country: primary?.country ?? null,
  };
}

/** Contact-method kinds a person form can edit ('name' is machine-asserted). */
type ContactKind = Extract<IdentifierKind, 'email' | 'phone'>;

const CONTACT_KINDS: ContactKind[] = ['email', 'phone'];

function parseContactKind(raw: string): ContactKind {
  if (raw !== 'email' && raw !== 'phone') {
    throw new BadRequestException(`Unknown contact kind "${raw}" — expected email or phone`);
  }

  return raw;
}

/**
 * The 409 for contact values another person already holds. The value stays
 * with its holder (first-writer-wins, same as ingest): the right fix is a
 * merge, not a re-point.
 */
function contactConflictException(conflicts: ReadonlyArray<{ value: string }>): ConflictException {
  return new ConflictException(
    `${conflicts.map((conflict) => conflict.value).join(', ')} already ${
      conflicts.length === 1 ? 'belongs' : 'belong'
    } to another person. Merge the two people instead of re-assigning it.`,
  );
}

/**
 * Fold the labelled `contacts` list and the flat `emails`/`phones` arrays into
 * one list. Both shapes are accepted (capture sources send the flat arrays, the
 * person form sends labelled contacts); `contacts` is applied first so its
 * labels survive when the same value arrives twice.
 */
function mergeContactInputs(input: {
  contacts?: PersonContactInput[];
  emails?: string[];
  phones?: string[];
}): Array<{ kind: ContactKind; value: string; label?: string; isPrimary?: boolean }> {
  const merged: Array<{ kind: ContactKind; value: string; label?: string; isPrimary?: boolean }> = [];

  for (const contact of input.contacts ?? []) {
    if (contact.value.trim() === '') {
      continue;
    }

    merged.push({
      kind: parseContactKind(contact.kind),
      value: contact.value,
      label: contact.label,
      isPrimary: contact.isPrimary,
    });
  }

  for (const email of input.emails ?? []) {
    merged.push({ kind: 'email', value: email });
  }

  for (const phone of input.phones ?? []) {
    merged.push({ kind: 'phone', value: phone });
  }

  return merged;
}

const IDENTIFIER_KINDS: IdentifierKind[] = ['email', 'phone', 'name'];

function parseIdentifierKind(raw: string): IdentifierKind | null {
  return (IDENTIFIER_KINDS as string[]).includes(raw) ? (raw as IdentifierKind) : null;
}

const DUPLICATE_REASONS: DuplicateReason[] = ['email', 'phone', 'name'];

/** Reject an unknown reason loudly rather than silently returning everything. */
function parseDuplicateReasons(raw: string[] | undefined): DuplicateReason[] | undefined {
  if (raw == null || raw.length === 0) {
    return undefined;
  }

  const unknown = raw.filter((reason) => !(DUPLICATE_REASONS as string[]).includes(reason));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown duplicate reason ${unknown.join(', ')} — expected email, phone, or name`,
    );
  }

  return raw as DuplicateReason[];
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => PersonType)
export class PersonResolver {
  constructor(
    private readonly personService: PersonService,
    private readonly personMergeService: PersonMergeService,
    private readonly personDuplicateService: PersonDuplicateService,
    private readonly mergeCandidateService: MergeCandidateService,
    private readonly entityMergeBlockService: EntityMergeBlockService,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly personIdentifiersLoader: PersonIdentifiersLoader,
    private readonly personInteractionStatsLoader: PersonInteractionStatsLoader,
    private readonly tagLoader: TagLoader,
    private readonly graphQuery: GraphQueryService,
  ) {}

  @Mutation(() => CreatePersonPayload)
  // Calls entityIdentifierService.replaceForEntity, but on a BRAND NEW entity — there is no prior
  // identifier row it could drop, unlike the same call in updatePerson.
  @GraphqlPrivacy({ destructive: false })
  async createPerson(
    @Context() context: RequestContext,
    @Args('input') input: CreatePersonInput,
  ): Promise<CreatePersonPayload> {
    const serviceContext = toServiceContext(context);

    const contacts = mergeContactInputs(input);

    const properties = {
      ...structuredPropertiesPatch(input),
      // The list wins when both shapes arrive: it carries the flat keys' values
      // as its primary address anyway.
      ...(input.addresses ? addressPropertiesPatch(input.addresses) : {}),
    };

    const emails = contacts.filter((contact) => contact.kind === 'email').map((contact) => contact.value);
    const phones = contacts.filter((contact) => contact.kind === 'phone').map((contact) => contact.value);

    if (emails.length > 0) {
      properties.emails = emails;
    }

    if (phones.length > 0) {
      properties.phones = phones;
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
    if (contacts.length > 0) {
      await this.entityIdentifierService
        .replaceForEntity(serviceContext.userId, entity.id, ['email', 'phone'], contacts)
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
  @GraphqlPrivacy({ destructive: false })
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
          ...(item.addresses ? addressPropertiesPatch(item.addresses) : {}),
          ...(item.emails?.length ? { emails: item.emails } : {}),
          ...(item.phones?.length ? { phones: item.phones } : {}),
        },
      })),
    );

    return people.map((person) => PersonType.toType(person));
  }

  @Mutation(() => UpdatePersonPayload)
  // NOT a plain field patch. When `input.contacts` is supplied, this calls
  // EntityIdentifierService.replaceForEntity(['email','phone'], contacts) — which, per its own doc
  // comment, "deletes the rows of those kinds that are no longer listed". ci.entity_identifiers has
  // no soft-delete column (see removePersonIdentifier above), so a caller that passes a shorter
  // contacts list than what's stored permanently drops the omitted email/phone identifiers, with no
  // restore path. This is the same hard-delete removePersonIdentifier is declared destructive for,
  // reachable through a mutation named like an ordinary update — flagged as the audit's own example
  // of the bug class this file exists to close. The omitted values also leave the person's own
  // email/emails/phone/phones properties (droppedContactsPatch), equally without a restore path.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async updatePerson(
    @Context() context: RequestContext,
    @Args('input') input: UpdatePersonInput,
  ): Promise<UpdatePersonPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('person', input.id);

    // Contact methods live in ci.entity_identifiers, which is owner-scoped but
    // NOT person-scoped — writing them for a person this user does not own would
    // leave dangling rows behind the `patch` below rejecting the whole update.
    // Establish ownership first.
    if (input.contacts !== undefined) {
      const owned = await this.personService.findById(serviceContext, id);
      if (owned == null) {
        return { success: false };
      }

      const submitted = input.contacts.map((contact) => ({
        kind: parseContactKind(contact.kind),
        value: contact.value,
        label: contact.label,
        isPrimary: contact.isPrimary,
      }));

      // What the user removed: a row the form showed and no longer sends. Read
      // from the WHOLE submission, never from a list narrowed for the index —
      // one that leaves out rows the user kept without asserting them (an
      // untouched property-only contact) would call every such row removed.
      const dropped = droppedContactsPatch(owned, submitted);

      // The form re-submits every contact it was seeded with, property-only
      // ones included. Only what the user asserted reaches the index: see
      // contactsToReconcile. The conflict check has to see that same list: a
      // value filtered out of it is never written, so it cannot conflict.
      const indexed = await this.entityIdentifierService.listForEntities(serviceContext.userId, [id]);
      const contacts = contactsToReconcile(submitted, {
        indexed: indexed.get(id) ?? [],
        stated: contactMethodsFromPersonProperties(owned),
      });

      // A value another person already holds fails the whole update HERE,
      // before anything is written. replaceForEntity only meets a conflict at
      // the insert, after it has deleted every row missing from the list:
      // refusing then would keep the contact changes, skip the name /
      // description / address patch below, and leave Cancel on the error
      // unable to bring back a number the user edited into the claimed value.
      const claimed = await this.entityIdentifierService.findConflicts(
        serviceContext.userId,
        id,
        CONTACT_KINDS,
        contacts,
      );
      if (claimed.length > 0) {
        throw contactConflictException(claimed);
      }

      const { conflicts } = await this.entityIdentifierService.replaceForEntity(
        serviceContext.userId,
        id,
        CONTACT_KINDS,
        contacts,
      );

      // The row keeps its own copies of contact methods, and `identifiers`
      // shows them: a contact the form dropped has to leave them too, or it is
      // back on the next read. Written before a conflict is reported, because
      // the index half of this edit already was.
      if (Object.keys(dropped).length > 0) {
        await this.personService.patch(serviceContext, id, { propertiesPatch: dropped });
      }

      this.personIdentifiersLoader.clear(serviceContext, id);

      if (conflicts.length > 0) {
        // Only when another writer (an import, a message minting a participant
        // stub) claimed a value between the read above and the write: the rest
        // of the list is applied by now, but say so rather than drop the value
        // without a word.
        throw contactConflictException(conflicts);
      }
    }

    const entity = await this.personService.patch(serviceContext, id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      propertiesPatch: {
        ...structuredPropertiesPatch(input),
        ...(input.addresses ? addressPropertiesPatch(input.addresses) : {}),
      },
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
  @GraphqlPrivacy({ access: 'delete', destructive: true })
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
  // Tombstones every source (is_active = FALSE) and drops their search rows. Takes an ARRAY of
  // source ids, so one call at `write` could retire an unbounded number of people. One-way.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async mergePeople(
    @Context() context: RequestContext,
    @Args('input') input: MergePeopleInput,
  ): Promise<MergePeoplePayload> {
    const serviceContext = toServiceContext(context);

    const sourceIds = input.sourceIds.map((gid) => GlobalUID.parse('person', gid));
    const targetId = GlobalUID.parse('person', input.targetId);

    const person = await this.personMergeService.mergePeople(serviceContext, sourceIds, targetId);

    // Close the loop on the detector's proposals: any pending pair contained in
    // what was just merged has been answered, and leaving it pending would ask
    // the same question about people who are now one row.
    await this.mergeCandidateService.resolvePairs(serviceContext, [targetId, ...sourceIds], 'accepted');

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
  // Writes entity_merge_blocks rows to suppress a re-proposal; touches no person or search data.
  @GraphqlPrivacy({ destructive: false })
  async rejectPersonDuplicates(
    @Context() context: RequestContext,
    @Args('personIds', { type: () => [ID] }) personIds: string[],
  ): Promise<boolean> {
    const ids = personIds.map((gid) => GlobalUID.parse('person', gid));

    const serviceContext = toServiceContext(context);

    await this.entityMergeBlockService.blockAllPairs(serviceContext, ids, 'user_rejected');
    // Same decision, recorded in the detector's queue as well — a rejected pair
    // must leave the review queue, not just stop being recomputed.
    await this.mergeCandidateService.resolvePairs(serviceContext, ids, 'rejected');

    return true;
  }

  /** Add a contact method / identifier to a person (source='user'). */
  @Mutation(() => [PersonIdentifierType])
  @GraphqlPrivacy({ destructive: false })
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
  // Correct today only by naming accident. This is NOT the "scope detach" it looks like:
  // EntityIdentifierService.removeForEntity is a bare repository.delete against
  // ci.entity_identifiers, a table with no soft-delete column. addPersonIdentifier restores the
  // row only while the (kind, value) tuple is unclaimed, and CommunicationParticipantLinkListener
  // mints a stub Person that claims it on the next inbound communication — after which the only
  // repair is mergePeople, which is itself destructive and has no unmerge. An email or phone also
  // leaves the person's own email/emails/phone/phones properties (removedContactPatch).
  @GraphqlPrivacy({ access: 'delete', destructive: true })
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

    // The person's own copy too, or `identifiers` keeps showing it and the
    // identifier backfill re-indexes it. See droppedContactsPatch.
    if (kind !== 'name') {
      const person = await this.personService.findById(serviceContext, personId);
      const removed = person ? removedContactPatch(person, kind, input.value) : {};
      if (Object.keys(removed).length > 0) {
        await this.personService.patch(serviceContext, personId, { propertiesPatch: removed });
      }
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

    const entity = await this.personService.findById(serviceContext, id);

    return entity ? PersonType.toType(entity) : null;
  }

  /**
   * Duplicate-person suggestions for the merge review UI: groups of live
   * people sharing a normalized email, phone, or display name.
   */
  @Query(() => PersonDuplicatesPayload)
  async personDuplicates(
    @Context() context: RequestContext,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
    @Args('reasons', { type: () => [String], nullable: true }) reasons?: string[],
  ): Promise<PersonDuplicatesPayload> {
    const serviceContext = toServiceContext(context);

    const page = await this.personDuplicateService.findDuplicateGroups(serviceContext, {
      limit: limit ?? undefined,
      offset: offset ?? undefined,
      reasons: parseDuplicateReasons(reasons),
    });

    return {
      totalCount: page.totalCount,
      hasMore: page.hasMore,
      groups: page.groups.map((group) => ({
        reason: group.reason,
        value: group.value,
        totalPeople: group.totalPeople,
        people: group.people.map((person) => PersonType.toType(person)),
      })),
    };
  }

  /**
   * The duplicate-detection pipeline's own review queue — scored pairs from
   * `ci.merge_candidates`, strongest first, each carrying the evidence that
   * justified it.
   *
   * Until this query the table was write-only: `clean.duplicate_detect` filed
   * proposals nobody could read. Accepting one is `mergePeople`; declining it is
   * `rejectPersonDuplicates` — both stamp the candidate row so the queue
   * shrinks as it is worked.
   */
  @Query(() => MergeCandidateConnection)
  async mergeCandidates(
    @Context() context: RequestContext,
    @Args('status', { type: () => String, nullable: true }) status?: string,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<MergeCandidateConnection> {
    const serviceContext = toServiceContext(context);

    let parsedStatus: MergeCandidateStatus = 'pending';
    if (status != null) {
      if (!isMergeCandidateStatus(status)) {
        throw new BadRequestException(
          `Unknown merge-candidate status "${status}" — expected pending, accepted, or rejected`,
        );
      }

      parsedStatus = status;
    }

    // Disabling the hourly drain on the Jobs page is the one kill switch for
    // the phone and profile-URL tiers: it stops the cron AND this on-read
    // fold, and the queue then shows exact phone and profile-URL pairs for
    // review instead of hiding them. Only email pairs fold here either way.
    const includeProfileUrl = JobControlStore.cronMode(DETERMINISTIC_MERGE_CRON) !== 'disabled';
    const includePhone = includeProfileUrl;

    // A shared email, an adjudicated exact phone or an exact LinkedIn profile
    // URL is the same person. Fold those before the queue is shown so "95% match" on
    // a shared mailbox never sits waiting for a click. Bounded by time, not
    // by rows: a detector re-sweep can leave ~2k deterministic pairs at once,
    // and draining them synchronously would turn one page load into minutes.
    // Whatever is left is hidden from the queue and folded by
    // `DeterministicPersonMergeCron` or the next load.
    if (parsedStatus === 'pending') {
      await this.mergeCandidateService.autoMergeDeterministicPairs(serviceContext, {
        budgetMs: ON_READ_FOLD_BUDGET_MS,
        includeProfileUrl,
        includePhone,
      });

      // A card that says "Same phone number" must be about a number both
      // people's records still carry. The detector never withdraws a pair and
      // is not re-run when a record changes, so stored phone evidence is
      // re-checked against the live records before the queue is shown —
      // rewritten to what still holds, retired when nothing does. Not gated
      // by the kill switch: it merges nothing. Once per visit, on the first
      // page: it covers the whole queue, and later pages would only repeat it.
      if (after == null) {
        await this.mergeCandidateService.revalidatePhoneEvidence(serviceContext, {
          budgetMs: ON_READ_PHONE_RECHECK_BUDGET_MS,
        });
      }
    }

    const page = await this.mergeCandidateService.findCandidates(serviceContext, {
      status: parsedStatus,
      limit: first ?? undefined,
      after: after ?? null,
      includeProfileUrl,
      includePhone,
    });

    const edges = page.candidates.map((candidate) => ({
      cursor: encodeMergeCandidateCursor(candidate),
      node: MergeCandidateType.toType(candidate),
    }));

    return {
      edges,
      totalCount: page.totalCount,
      pageInfo: {
        hasNextPage: page.hasNextPage,
        hasPreviousPage: after != null,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: page.endCursor,
      },
    };
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

  /**
   * Contact methods for this person. Indexed `ci.entity_identifiers` rows plus
   * emails/phones still sitting on the person properties — import often writes
   * the address onto the row and never copies it into the identifier table, and
   * the Details card only reads this field.
   */
  @ResolveField(() => [PersonIdentifierType])
  async identifiers(
    @Context() context: RequestContext,
    @Parent() parent: PersonType,
  ): Promise<PersonIdentifierType[]> {
    const serviceContext = toServiceContext(context);

    const rows = await this.personIdentifiersLoader.load(serviceContext, parent.__source.id);

    return mergePersonIdentifiers(
      rows.map((row) => PersonIdentifierType.toType(row)),
      contactMethodsFromPersonProperties(parent.__source),
    );
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
