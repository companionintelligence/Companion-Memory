import type { UserServiceContext } from '@ci/common/context';

import { CommunicationService } from './CommunicationService';

/**
 * The Who filter's SQL, and how the sent / received toggle bends it. Without a
 * direction a message counts if the person is its sender OR among its
 * recipients. With one, the person must hold the role the direction implies —
 * `inbound` (received) is from them, `outbound` (sent) is to them — so a group
 * chat the person merely belongs to does not surface every other member's
 * messages under Received. The fetch and its COUNT(*) share the predicate.
 */
const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

type Where = { sql: string; params?: Record<string, unknown> };

function makeService() {
  const wheres: Where[] = [];

  const builder: Record<string, unknown> = {};
  const chain = () => builder;

  Object.assign(builder, {
    select: chain,
    where: chain,
    limit: chain,
    orderBy: chain,
    addOrderBy: chain,
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      wheres.push({ sql, params });

      return builder;
    },
    getRawMany: async () => [],
    getCount: async () => 0,
  });

  const dataSource = { getRepository: () => ({ createQueryBuilder: () => builder }) };

  const service = new CommunicationService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send: jest.fn() } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
  );

  return { service, wheres };
}

const SENDER_MATCH = 'communications.from_entity_id IN (';
const RECIPIENT_MATCH = 'communications.to_entity_ids && ARRAY(';

function peopleWhere(wheres: Where[]): Where {
  const found = wheres.find((where) => where.params != null && 'peoplePatterns' in where.params);

  if (!found) {
    throw new Error('no Who predicate was applied');
  }

  return found;
}

describe('CommunicationService — the Who filter and the direction toggle', () => {
  it('without a direction keeps a message the person sent OR received, on any of the patterns', async () => {
    const { service, wheres } = makeService();

    await service.getEntitiesForCommunications(CONTEXT, { people: ['Bri', 'Ada'] });

    const { sql, params } = peopleWhere(wheres);

    expect(sql).toContain(SENDER_MATCH);
    expect(sql).toContain(RECIPIENT_MATCH);
    expect(sql).toMatch(/\) OR communications\.to_entity_ids/);
    expect(sql).toContain('ILIKE ANY(:peoplePatterns)');
    expect(params).toEqual({ userId: USER, peoplePatterns: ['%Bri%', '%Ada%'] });
    expect(wheres.some((where) => where.sql.includes('communications.direction ='))).toBe(false);
  });

  it('under Received binds the person to the sender, so a group chat they only belong to does not match', async () => {
    const { service, wheres } = makeService();

    await service.getEntitiesForCommunications(CONTEXT, { people: ['Bri'], direction: 'inbound' });

    const { sql } = peopleWhere(wheres);

    expect(sql).toContain(SENDER_MATCH);
    expect(sql).not.toContain(RECIPIENT_MATCH);
    expect(wheres).toContainEqual({
      sql: 'communications.direction = :direction',
      params: { direction: 'inbound' },
    });
  });

  it('under Sent binds the person to the recipients', async () => {
    const { service, wheres } = makeService();

    await service.getEntitiesForCommunications(CONTEXT, { people: ['Bri'], direction: 'outbound' });

    const { sql } = peopleWhere(wheres);

    expect(sql).toContain(RECIPIENT_MATCH);
    expect(sql).not.toContain(SENDER_MATCH);
    expect(wheres).toContainEqual({
      sql: 'communications.direction = :direction',
      params: { direction: 'outbound' },
    });
  });

  it('falls back to either role for a direction the toggle cannot name', async () => {
    const { service, wheres } = makeService();

    await service.getEntitiesForCommunications(CONTEXT, { people: ['Bri'], direction: 'internal' });

    const { sql } = peopleWhere(wheres);

    expect(sql).toContain(SENDER_MATCH);
    expect(sql).toContain(RECIPIENT_MATCH);
  });

  it('applies the same role-bound predicate to the COUNT(*), so a page and its total agree', async () => {
    const { service, wheres } = makeService();

    await service.countEntitiesForCommunications(CONTEXT, { people: ['Bri'], direction: 'inbound' });

    const { sql } = peopleWhere(wheres);

    expect(sql).toContain(SENDER_MATCH);
    expect(sql).not.toContain(RECIPIENT_MATCH);
  });
});
