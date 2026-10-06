import { WriteKnowledgeTool } from '../WriteKnowledgeTool';

/**
 * `memory.remember` is declared a plain write because adding a fact is what it mostly does. Two
 * things follow from that label, and these pin both:
 *
 * - It may not touch the keys the appliance keeps for itself. The owner's autonomy dial lives at
 *   `planner.trust_mode` on their own Person, and a model asked to "remember" a hands-off setting
 *   used to switch the approval gate off with one call.
 * - A call that can lose stored data is labelled destructive for that call (`privacyFor`), so a
 *   write key is refused it and the dial asks before it runs.
 */

const SELF = '11111111-1111-1111-1111-111111111111';
const ALEX = '22222222-2222-2222-2222-222222222222';
const CLAIMS_SELF = '33333333-3333-3333-3333-333333333333';
const IDEA = '44444444-4444-4444-4444-444444444444';
const EDGE = '55555555-5555-5555-5555-555555555555';
const OWNER = { userId: 'user-1' };

interface FakeNode {
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  linked_table: string | null;
  linked_id: string | null;
  is_active: boolean;
}

function node(overrides: Partial<FakeNode> & { entity_id: string; entity_type: string }): FakeNode {
  return {
    name: null,
    description: null,
    properties: {},
    linked_table: null,
    linked_id: null,
    is_active: true,
    ...overrides,
  };
}

function makeTool() {
  const nodes = new Map<string, FakeNode>(
    [
      node({
        entity_id: SELF,
        entity_type: 'Person',
        name: 'Robin Vale',
        properties: { planner: { trust_mode: 'cautious' } },
      }),
      node({
        entity_id: ALEX,
        entity_type: 'Person',
        name: 'Alex',
        description: 'Neighbour, two doors down',
      }),
      node({ entity_id: CLAIMS_SELF, entity_type: 'Person', name: 'Me', properties: { is_self: 'true' } }),
      node({ entity_id: IDEA, entity_type: 'Concept', name: null, description: null }),
    ].map((entry) => [entry.entity_id, entry]),
  );
  const edges = new Map([
    [
      EDGE,
      {
        relationship_id: EDGE,
        from_entity_id: ALEX,
        to_entity_id: IDEA,
        relationship_type: 'KNOWS',
        properties: { since: '2019' },
        strength: 1,
        is_bidirectional: false,
        is_active: true,
      },
    ],
  ]);

  const upsertNode = jest.fn(async (_owner: string, input: { entityId?: string }) => ({
    entityId: input.entityId ?? IDEA,
  }));
  const upsertRelationship = jest.fn(async (_owner: string, input: { relationshipId?: string }) => ({
    relationshipId: input.relationshipId ?? EDGE,
  }));
  const graphQuery = {
    getNode: jest.fn(async (_owner: string, id: string) => nodes.get(id) ?? null),
    getRelationships: jest.fn(async (_owner: string, options: { relationshipIds?: string[] }) =>
      (options.relationshipIds ?? []).map((id) => edges.get(id)).filter(Boolean),
    ),
    getNodesByIds: jest.fn(async () => []),
    findLinkedKeyHolder: jest.fn(async () => null),
    findActiveRelationship: jest.fn(async () => null),
  };
  const getSelfIdentity = jest.fn(async () => ({ entityId: SELF, aliases: [] }));
  const logger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const tool = new WriteKnowledgeTool(
    { upsertNode, upsertRelationship } as never,
    graphQuery as never,
    logger as never,
    { getSelfIdentity } as never,
  );

  return { tool, upsertNode, upsertRelationship, getSelfIdentity };
}

describe('memory.remember refuses the keys the appliance keeps', () => {
  it.each([
    [
      'sets the autonomy dial',
      { kind: 'entity.update', entityId: ALEX, properties: { planner: { trust_mode: 'hands_off' } } },
    ],
    ['removes the self claim', { kind: 'entity.update', entityId: ALEX, removeProperties: ['is_self'] }],
    [
      'overwrites a merged identity list',
      { kind: 'entity.update', entityId: ALEX, properties: { phones: ['5550100'] } },
    ],
    [
      'creates a second account holder',
      { kind: 'entity.create', entityType: 'Person', name: 'Me', properties: { is_self: true } },
    ],
    [
      'writes a planner through an id-reuse create',
      { kind: 'entity.create', entityId: ALEX, entityType: 'Person', properties: { planner: {} } },
    ],
    [
      'overwrites an identity list through an id-reuse create',
      { kind: 'entity.create', entityId: ALEX, entityType: 'Person', properties: { emails: [] } },
    ],
    [
      'gives a new entity a planner',
      { kind: 'entity.create', entityType: 'Person', name: 'Dana', properties: { planner: {} } },
    ],
  ])('fails an operation that %s, and queues no write', async (_label, operation) => {
    const { tool, upsertNode } = makeTool();

    const result = await tool.execute(OWNER, { operations: [operation] });

    expect(result.success).toBe(true);
    expect(result.data?.failures).toBe(1);
    expect(result.data?.results[0]).toMatchObject({ status: 'failed' });
    expect(result.data?.results[0].message).toMatch(/cannot write or remove/);
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('lets a new entity carry the identity lists, which overwrite nothing there', async () => {
    const { tool, upsertNode } = makeTool();

    const result = await tool.execute(OWNER, {
      operations: [
        {
          kind: 'entity.create',
          entityType: 'Person',
          name: 'Dana',
          properties: { emails: ['dana@example.com'], phones: ['5550100'] },
        },
      ],
    });

    expect(result.data?.failures).toBe(0);
    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(upsertNode.mock.calls[0][1]).toMatchObject({
      properties: { emails: ['dana@example.com'], phones: ['5550100'] },
    });
  });

  it('still runs the other operations in the call', async () => {
    const { tool, upsertNode } = makeTool();

    const result = await tool.execute(OWNER, {
      operations: [
        { kind: 'entity.update', entityId: SELF, properties: { planner: { trust_mode: 'hands_off' } } },
        { kind: 'entity.update', entityId: ALEX, properties: { occupation: 'dentist' } },
      ],
    });

    expect(result.data?.failures).toBe(1);
    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(upsertNode.mock.calls[0][1]).toMatchObject({
      entityId: ALEX,
      properties: { occupation: 'dentist' },
    });
  });
});

describe('memory.remember labels each call', () => {
  const destructive = { access: 'write', sensitivity: 'personal', destructive: true, external: false };

  async function labelOf(operations: unknown[], extra: Record<string, unknown> = {}) {
    const { tool } = makeTool();

    return tool.privacyFor(OWNER, { operations, ...extra });
  }

  it('leaves an additive call a plain write', async () => {
    await expect(
      labelOf([{ kind: 'entity.create', entityType: 'Concept', name: 'Pilates' }]),
    ).resolves.toBeUndefined();
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, properties: { occupation: 'dentist' } }]),
    ).resolves.toBeUndefined();
    await expect(
      labelOf([
        { kind: 'relationship.create', fromEntityId: ALEX, toEntityId: IDEA, relationshipType: 'LIKES' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('leaves filling in an empty name or description a plain write', async () => {
    await expect(
      labelOf([
        { kind: 'entity.update', entityId: IDEA, name: 'Pilates', description: 'A class on Tuesdays' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('leaves restating the stored name a plain write', async () => {
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, name: ' Alex ' }]),
    ).resolves.toBeUndefined();
  });

  it('marks replacing the property bag destructive, also when the flag arrives as a string', async () => {
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, mergeProperties: false, properties: {} }]),
    ).resolves.toStrictEqual(destructive);
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, mergeProperties: 'false', properties: { a: 1 } }]),
    ).resolves.toStrictEqual(destructive);
  });

  it('marks removing keys destructive', async () => {
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, removeProperties: ['occupation'] }]),
    ).resolves.toStrictEqual(destructive);
  });

  it('marks overwriting a stored name or description destructive', async () => {
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, name: 'Alexandra' }]),
    ).resolves.toStrictEqual(destructive);
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, description: '' }]),
    ).resolves.toStrictEqual(destructive);
    await expect(
      labelOf([{ kind: 'entity.create', entityId: ALEX, entityType: 'Person', description: 'Someone else' }]),
    ).resolves.toStrictEqual(destructive);
  });

  it('marks a retype destructive, but not another spelling of the stored type', async () => {
    await expect(
      labelOf([{ kind: 'entity.update', entityId: IDEA, entityType: 'Person' }]),
    ).resolves.toStrictEqual(destructive);
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, entityType: 'person' }]),
    ).resolves.toBeUndefined();
  });

  it("marks any write to the owner's own Person destructive", async () => {
    await expect(
      labelOf([{ kind: 'entity.update', entityId: SELF, properties: { favourite_colour: 'green' } }]),
    ).resolves.toStrictEqual(destructive);
    await expect(
      labelOf([{ kind: 'entity.create', entityId: SELF, entityType: 'Person', properties: { a: 1 } }]),
    ).resolves.toStrictEqual(destructive);
  });

  it('treats a Person that claims to be the account holder as the owner too', async () => {
    await expect(
      labelOf([{ kind: 'entity.update', entityId: CLAIMS_SELF, properties: { favourite_colour: 'green' } }]),
    ).resolves.toStrictEqual(destructive);
  });

  it('marks a relationship replace, removal or retype destructive, but not a case change', async () => {
    await expect(
      labelOf([{ kind: 'relationship.update', relationshipId: EDGE, removeProperties: ['since'] }]),
    ).resolves.toStrictEqual(destructive);
    await expect(
      labelOf([
        { kind: 'relationship.update', relationshipId: EDGE, mergeProperties: false, properties: {} },
      ]),
    ).resolves.toStrictEqual(destructive);
    await expect(
      labelOf([{ kind: 'relationship.update', relationshipId: EDGE, relationshipType: 'works at' }]),
    ).resolves.toStrictEqual(destructive);
    await expect(
      labelOf([{ kind: 'relationship.update', relationshipId: EDGE, relationshipType: 'knows' }]),
    ).resolves.toBeUndefined();
  });

  it('is destructive when any one operation of several is', async () => {
    await expect(
      labelOf([
        { kind: 'entity.create', entityType: 'Concept', name: 'Pilates' },
        { kind: 'entity.update', entityId: ALEX, removeProperties: ['occupation'] },
      ]),
    ).resolves.toStrictEqual(destructive);
  });

  it('leaves a dry run and an input that will not validate unlabelled', async () => {
    await expect(
      labelOf([{ kind: 'entity.update', entityId: ALEX, removeProperties: ['occupation'] }], {
        dryRun: true,
      }),
    ).resolves.toBeUndefined();
    await expect(labelOf([{ kind: 'entity.update', entityId: 'not-a-uuid' }])).resolves.toBeUndefined();
  });

  it('only looks the owner up when an operation lands on an existing entity', async () => {
    const { tool, getSelfIdentity } = makeTool();

    await tool.privacyFor(OWNER, {
      operations: [{ kind: 'entity.create', entityType: 'Concept', name: 'Pilates' }],
    });

    expect(getSelfIdentity).not.toHaveBeenCalled();
  });
});
