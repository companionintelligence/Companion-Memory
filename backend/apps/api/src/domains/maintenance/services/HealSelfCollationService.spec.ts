import { HealSelfCollationService } from './HealSelfCollationService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const SELF = '00000000-0000-0000-0000-0000000000b1';
const STUB = '00000000-0000-0000-0000-0000000000b2';

function makeService(opts: {
  trustMode: 'cautious' | 'balanced' | 'hands_off';
  stubs?: Array<{ entity_id: string; name: string | null; properties: Record<string, unknown> }>;
}) {
  const stubs = opts.stubs ?? [
    {
      entity_id: STUB,
      name: 'Bennett',
      properties: { emails: ['owner@example.com'] },
    },
  ];

  const query = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT entity_id FROM ci.users')) {
      return [{ entity_id: SELF }];
    }

    if (sql.includes('FROM ci.users u')) {
      return [
        { name: 'Bennett', email: 'owner@example.com', phones_json: null },
        { name: 'Bennett', email: null, phones_json: [] },
      ];
    }

    if (sql.includes('FROM ci.entities') && sql.includes('entity_id <>')) {
      return stubs;
    }

    return [];
  });

  const personMerge = { mergePeople: jest.fn(async () => ({ sourcesMerged: 1 })) };
  const mergeBlocks = { blockedPairsAmong: jest.fn(async () => new Set()) };
  const personalization = {
    getTrustMode: jest.fn(async () => opts.trustMode),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };

  return {
    service: new HealSelfCollationService(
      { query } as never,
      personMerge as never,
      mergeBlocks as never,
      personalization as never,
      logger as never,
    ),
    personMerge,
    query,
  };
}

describe('HealSelfCollationService', () => {
  it('merges exact owner email stubs into self under hands_off', async () => {
    const { service, personMerge } = makeService({ trustMode: 'hands_off' });

    const result = await service.heal(USER);

    expect(result.examined).toBe(1);
    expect(result.merged).toBe(1);
    expect(result.mergedSourceIds).toEqual([STUB]);
    expect(personMerge.mergePeople).toHaveBeenCalledWith({ userId: USER }, [STUB], SELF);
  });

  it('does not silent-merge under balanced — surfaces as reviewed', async () => {
    const { service, personMerge } = makeService({ trustMode: 'balanced' });

    const result = await service.heal(USER);

    expect(result.merged).toBe(0);
    expect(result.reviewed).toBe(1);
    expect(personMerge.mergePeople).not.toHaveBeenCalled();
  });

  it('is idempotent when no owner stubs remain', async () => {
    const { service, personMerge } = makeService({ trustMode: 'hands_off', stubs: [] });

    const first = await service.heal(USER);
    const second = await service.heal(USER);

    expect(first.examined).toBe(0);
    expect(second.examined).toBe(0);
    expect(personMerge.mergePeople).not.toHaveBeenCalled();
  });

  it('does not take a Person for the owner because it holds a phone number', async () => {
    // Each candidate's phones used to be passed in as the OWNER's phones, so a
    // Person with any number matched itself at phone confidence and hands_off
    // merged it into self every night.
    const { service, personMerge } = makeService({
      trustMode: 'hands_off',
      stubs: [{ entity_id: STUB, name: 'Dana Example', properties: { phones: ['4155550199'] } }],
    });

    const result = await service.heal(USER);

    expect(result.examined).toBe(0);
    expect(result.merged).toBe(0);
    expect(personMerge.mergePeople).not.toHaveBeenCalled();
  });

  it('leaves a name-only match for review even under hands_off', async () => {
    // A merge into self moves every address the stub holds onto the owner.
    // Sharing the owner's name is not evidence those addresses are theirs.
    const { service, personMerge } = makeService({
      trustMode: 'hands_off',
      stubs: [{ entity_id: STUB, name: 'Bennett', properties: { emails: ['bennett@other.example'] } }],
    });

    const result = await service.heal(USER);

    expect(result.examined).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.reviewed).toBe(1);
    expect(personMerge.mergePeople).not.toHaveBeenCalled();
  });

  it('does not take a Person named only by an address for the owner', async () => {
    // "bennett@elsewhere.example" folds to "bennett elsewhere example", which
    // contains the owner's name. matchOwner refuses a name that is only an
    // address, and no name-only fallback may let it back in.
    const { service, personMerge } = makeService({
      trustMode: 'hands_off',
      stubs: [{ entity_id: STUB, name: 'bennett@elsewhere.example', properties: {} }],
    });

    const result = await service.heal(USER);

    expect(result.examined).toBe(0);
    expect(result.reviewed).toBe(0);
    expect(personMerge.mergePeople).not.toHaveBeenCalled();
  });

  it('honours dryRun without calling mergePeople', async () => {
    const { service, personMerge } = makeService({ trustMode: 'hands_off' });

    const result = await service.heal(USER, { dryRun: true });

    expect(result.merged).toBe(1);
    expect(personMerge.mergePeople).not.toHaveBeenCalled();
  });
});
