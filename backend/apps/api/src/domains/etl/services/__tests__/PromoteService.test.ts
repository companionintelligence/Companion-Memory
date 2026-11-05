import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { NodeService, RelationshipService } from '@ci/domains/graph';
import type { Person, PersonService } from '@ci/domains/memory';
import type { UserService } from '@ci/domains/user';

import { PromoteService } from '../PromoteService';

const CONTEXT = { userId: 'user-1' } as UserServiceContext;
const USER_NODE = { entityId: 'user-1-entity' };
const USER = { id: 'user-1', email: 'me@example.com', entityId: 'user-1-entity' };

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'person-generated',
    name: 'Someone',
    email: null,
    properties: {},
    ...overrides,
  } as unknown as Person;
}

function buildService(
  overrides: {
    personService?: Partial<PersonService>;
    userService?: Partial<UserService>;
    nodeService?: Partial<NodeService>;
  } = {},
) {
  let createCounter = 0;
  const personService = {
    findById: jest.fn().mockResolvedValue(makePerson({ id: USER_NODE.entityId })),
    findByEmails: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (_ctx, dto) => {
      createCounter += 1;

      // The service mints a uuid per new person; the double names them in
      // creation order so the assertions can tell them apart.
      return makePerson({
        id: `created-${createCounter}`,
        name: dto.name,
        email: dto.properties?.email ?? null,
        properties: dto.properties,
      });
    }),
    ...overrides.personService,
  } as unknown as PersonService;

  const userService = {
    findById: jest.fn().mockResolvedValue(USER),
    ...overrides.userService,
  } as unknown as UserService;

  const nodeService = {
    findNodeByUserId: jest.fn().mockResolvedValue(USER_NODE),
    ...overrides.nodeService,
  } as unknown as NodeService;

  const relationshipService = {
    createMany: jest.fn(async () => []),
  } as unknown as RelationshipService;
  const eventService = {} as never;
  const connectionRepository = {} as never;
  const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

  const service = new PromoteService(
    connectionRepository,
    eventService,
    personService,
    userService,
    nodeService,
    relationshipService,
    logger,
  );

  return { service, personService, userService, nodeService, relationshipService };
}

describe('PromoteService.upsertPeopleFromParticipants', () => {
  it("resolves the caller's own Person node by email match instead of creating a duplicate", async () => {
    const { service, personService } = buildService();

    const { entities, relationships } = await service.upsertPeopleFromParticipants(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      participants: [{ email: 'ME@Example.com', name: 'Me Myself' }],
    });

    expect(entities[0].id).toBe(USER_NODE.entityId);
    expect(relationships[0]).toBeNull();
    expect(personService.create).not.toHaveBeenCalled();
    // The owner's address is never looked up among contacts.
    expect(personService.findByEmails).toHaveBeenCalledWith(CONTEXT, []);
  });

  it('reuses an existing Person found by email instead of creating a new one', async () => {
    const existing = makePerson({
      id: 'existing-person',
      name: 'Alice Existing',
      email: 'alice@example.com',
    });
    const { service, personService } = buildService({
      personService: { findByEmails: jest.fn().mockResolvedValue([existing]) },
    });

    const { entities } = await service.upsertPeopleFromParticipants(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      participants: [{ email: 'Alice@Example.com', name: 'Alice' }],
    });

    expect(entities[0].id).toBe('existing-person');
    expect(personService.findByEmails).toHaveBeenCalledWith(CONTEXT, ['alice@example.com']);
    expect(personService.create).not.toHaveBeenCalled();
  });

  it('creates a new Person with a name split into first/last and source-stamped properties', async () => {
    const { service, personService } = buildService();

    await service.upsertPeopleFromParticipants(CONTEXT, {
      connectionId: 'conn-42',
      source: 'calendar',
      participants: [{ email: 'bob.jones@example.com', name: 'Bob Jones' }],
    });

    expect(personService.create).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({
        name: 'Bob Jones',
        properties: expect.objectContaining({
          email: 'bob.jones@example.com',
          first_name: 'Bob',
          last_name: 'Jones',
          contact_type: 'calendar',
          owner_user_id: 'user-1',
          connection_id: 'conn-42',
        }),
      }),
    );
  });

  it('uses the full name as first_name and null last_name for a single-word name', async () => {
    const { service, personService } = buildService();

    await service.upsertPeopleFromParticipants(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      participants: [{ email: 'cher@example.com', name: 'Cher' }],
    });

    expect(personService.create).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({
        properties: expect.objectContaining({ first_name: 'Cher', last_name: null }),
      }),
    );
  });

  /**
   * Regression coverage for a real dedup bug: two participants whose raw
   * email differed only by case — or the exact same raw email appearing twice
   * — used to miss the in-request cache and race their own
   * search-then-create, producing duplicate Person rows for one address in a
   * single call. Addresses are resolved once per page now, by lower-cased
   * key, so the second occurrence can only ever see the first's result.
   */
  it('dedupes participants that share an email but differ in case', async () => {
    const { service, personService } = buildService();

    const { entities } = await service.upsertPeopleFromParticipants(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      participants: [
        { email: 'Dana@Example.com', name: 'Dana One' },
        { email: 'dana@example.com', name: 'Dana Two' },
      ],
    });

    expect(personService.create).toHaveBeenCalledTimes(1);
    // The first participant to carry the address names it.
    expect(personService.create).toHaveBeenCalledWith(CONTEXT, expect.objectContaining({ name: 'Dana One' }));
    expect(entities[0].id).toBe(entities[1].id);
  });

  it('dedupes the exact same participant email appearing twice in one call', async () => {
    const { service, personService } = buildService();

    const { entities } = await service.upsertPeopleFromParticipants(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      participants: [
        { email: 'repeat@example.com', name: 'Repeat Person' },
        { email: 'repeat@example.com', name: 'Repeat Person' },
      ],
    });

    expect(personService.create).toHaveBeenCalledTimes(1);
    expect(entities[0].id).toBe(entities[1].id);
  });

  it('creates distinct people for distinct emails and keeps entities/relationships aligned by index', async () => {
    const { service } = buildService();

    const { entities, relationships } = await service.upsertPeopleFromParticipants(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      participants: [
        { email: 'ME@Example.com', name: 'Me' },
        { email: 'other@example.com', name: 'Other Person' },
      ],
    });

    expect(entities).toHaveLength(2);
    expect(entities[0].id).toBe(USER_NODE.entityId);
    expect(entities[1].id).not.toBe(USER_NODE.entityId);
    // relationships mirrors entities index-for-index, nulling out only the user.
    expect(relationships[0]).toBeNull();
    expect(relationships[1]).toEqual(entities[1]);
  });

  it("throws when the caller's own graph node cannot be resolved", async () => {
    const { service } = buildService({
      personService: { findById: jest.fn().mockResolvedValue(null) },
    });

    await expect(
      service.upsertPeopleFromParticipants(CONTEXT, {
        connectionId: 'conn-1',
        source: 'email',
        participants: [{ email: 'me@example.com', name: 'Me' }],
      }),
    ).rejects.toThrow('User graph node could not be obtained');
  });
});

describe('PromoteService.promoteParticipantGroups', () => {
  const alice = makePerson({ id: 'alice-id', name: 'Alice', email: 'alice@example.com' });

  it('resolves every group of a page with one owner lookup, one email lookup and one edge write', async () => {
    const { service, personService, userService, nodeService, relationshipService } = buildService({
      personService: { findByEmails: jest.fn().mockResolvedValue([alice]) },
    });

    const ids = await service.promoteParticipantGroups(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      groups: [
        // Message 1: from Alice, to me.
        {
          participants: [{ email: 'alice@example.com', name: 'Alice' }],
          relationshipType: 'RECEIVED_EMAIL_FROM',
        },
        { participants: [{ email: 'me@example.com', name: 'Me' }], relationshipType: 'EMAILED' },
        // Message 2: from me, to Alice and a newcomer.
        { participants: [{ email: 'me@example.com', name: 'Me' }], relationshipType: 'EMAILED' },
        {
          participants: [
            { email: 'Alice@example.com', name: 'Alice' },
            { email: 'new@example.com', name: 'New Person' },
          ],
          relationshipType: 'EMAILED',
        },
      ],
    });

    // Ids come back per group, aligned with each group's participants.
    expect(ids).toEqual([
      ['alice-id'],
      [USER_NODE.entityId],
      [USER_NODE.entityId],
      ['alice-id', 'created-1'],
    ]);

    expect(userService.findById).toHaveBeenCalledTimes(1);
    expect(nodeService.findNodeByUserId).toHaveBeenCalledTimes(1);
    expect(personService.findByEmails).toHaveBeenCalledTimes(1);
    expect(personService.findByEmails).toHaveBeenCalledWith(CONTEXT, [
      'alice@example.com',
      'new@example.com',
    ]);
    expect(personService.create).toHaveBeenCalledTimes(1);

    // One write for the page's edges, never one to the owner themselves.
    expect(relationshipService.createMany).toHaveBeenCalledTimes(1);
    const [, edges] = (relationshipService.createMany as jest.Mock).mock.calls[0];
    expect(edges.map((edge: { toNodeId: string; type: string }) => [edge.toNodeId, edge.type])).toEqual([
      ['alice-id', 'RECEIVED_EMAIL_FROM'],
      ['alice-id', 'EMAILED'],
      ['created-1', 'EMAILED'],
    ]);
    expect(edges[0]).toEqual(
      expect.objectContaining({
        fromNodeId: USER_NODE.entityId,
        fromNodeType: 'person',
        toNodeType: 'person',
        properties: expect.objectContaining({ source: 'email', connection_id: 'conn-1' }),
      }),
    );
  });

  it('does nothing for a page with no participants at all', async () => {
    const { service, userService, relationshipService } = buildService();

    const ids = await service.promoteParticipantGroups(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      groups: [
        { participants: [], relationshipType: 'EMAILED' },
        { participants: [], relationshipType: 'EMAILED' },
      ],
    });

    expect(ids).toEqual([[], []]);
    expect(userService.findById).not.toHaveBeenCalled();
    expect(relationshipService.createMany).not.toHaveBeenCalled();
  });

  it('still returns the ids when the edge write fails — the message is written against them', async () => {
    const { service, relationshipService } = buildService();
    (relationshipService.createMany as jest.Mock).mockRejectedValueOnce(new Error('edge write failed'));

    const ids = await service.promoteParticipantGroups(CONTEXT, {
      connectionId: 'conn-1',
      source: 'email',
      groups: [{ participants: [{ email: 'new@example.com', name: 'New' }], relationshipType: 'EMAILED' }],
    });

    expect(ids).toEqual([['created-1']]);
  });
});

describe('PromoteService.processParticipants', () => {
  it('is promoteParticipantGroups for one group', async () => {
    const { service, personService } = buildService();

    const ids = await service.processParticipants(
      [{ email: 'new@example.com', name: 'New' }],
      'user-1',
      'conn-1',
      'calendar',
      'MET_WITH',
      new Date('2026-01-01T00:00:00Z'),
    );

    expect(ids).toEqual(['created-1']);
    expect(personService.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ properties: expect.objectContaining({ contact_type: 'calendar' }) }),
    );
  });
});
