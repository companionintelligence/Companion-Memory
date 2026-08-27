import { AskAuditService } from '../AskAuditService';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function at(daysAgo: number): Date {
  return new Date(NOW.getTime() - daysAgo * 86_400_000);
}

let seq = 0;

function row(consentBasis: string | null, createdAt: Date) {
  seq += 1;

  return {
    id: `a-${seq}`,
    consentBasis,
    createdAt,
    outcome: 'answered',
    disclosedCount: 0,
    askerUserId: 'someone',
    peerLinkId: null,
    peerHandle: null,
    responderUserId: 'owner',
    query: { queryType: 'content', prompt: 'x' },
    disclosedEntities: [],
    backingEntities: [],
    withheldCount: 0,
    askId: null,
  };
}

function makeService(rows: unknown[]) {
  const repository = { find: jest.fn(async () => rows) };
  const logger = { setContext: jest.fn(), warn: jest.fn(), debug: jest.fn() };

  return new AskAuditService(repository as never, logger as never);
}

const CONTEXT = { userId: 'owner' } as never;

describe('AskAuditService.usageByGrant', () => {
  it('counts disclosures per grant and remembers the latest', async () => {
    const service = makeService([
      row('grant-a', at(10)),
      row('grant-a', at(2)),
      row('grant-a', at(30)),
      row('grant-b', at(5)),
    ]);

    const usage = await service.usageByGrant(CONTEXT);

    expect(usage.get('grant-a')).toEqual({ useCount: 3, lastUsedAt: at(2) });
    expect(usage.get('grant-b')).toEqual({ useCount: 1, lastUsedAt: at(5) });
  });

  /**
   * A grant that has never fired is ABSENT from the map, which the projection
   * renders as dormant. That is a different state from revoked and from lapsed,
   * and the matrix could not previously express it at all.
   */
  it('says nothing about a grant that has never been cited', async () => {
    const usage = await makeService([row('grant-a', at(1))]).usageByGrant(CONTEXT);

    expect(usage.has('grant-b')).toBe(false);
  });

  it('ignores disclosures with no consent basis — the owner decided those', async () => {
    const usage = await makeService([row(null, at(1)), row(null, at(2))]).usageByGrant(CONTEXT);

    expect(usage.size).toBe(0);
  });

  it('does not depend on the order rows arrive in', async () => {
    const rows = [row('g', at(1)), row('g', at(50)), row('g', at(20))];

    const forwards = await makeService(rows).usageByGrant(CONTEXT);
    const backwards = await makeService([...rows].reverse()).usageByGrant(CONTEXT);

    expect(forwards.get('g')).toEqual(backwards.get('g'));
    expect(forwards.get('g')?.lastUsedAt).toEqual(at(1));
  });

  it('is empty for an owner with no audit rows at all', async () => {
    expect((await makeService([]).usageByGrant(CONTEXT)).size).toBe(0);
  });
});
