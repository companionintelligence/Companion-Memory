import { BadRequestException } from '@nestjs/common';

import {
  AskBroadcastService,
  MAX_BROADCAST_RECIPIENTS,
  MIN_BROADCAST_RECIPIENTS,
  normalizeRecipients,
} from './AskBroadcastService';

const OWNER = { userId: 'asker-1' } as never;
const QUERY = { queryType: 'content', dataClass: 'photos', prompt: 'reunion photos' } as never;

function makeService(options: { failFor?: string[] } = {}) {
  const saved: Record<string, unknown>[] = [];
  const asks: Record<string, unknown>[] = [];

  const broadcastRepository = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => {
      saved.push(row);

      return row;
    }),
    delete: jest.fn(async () => undefined),
    findOne: jest.fn(async () => saved[0]),
    find: jest.fn(async () => saved),
  };

  const askRepository = { find: jest.fn(async () => asks) };

  const askService = {
    submit: jest.fn(async (_ctx: unknown, dto: Record<string, unknown>) => {
      if (options.failFor?.includes(dto.responderUserId as string)) {
        throw new BadRequestException('An ask must be directed at another user');
      }

      const ask = { id: `ask-${dto.responderUserId}`, ...dto };
      asks.push(ask);

      return { ask, decision: 'review' };
    }),
  };

  const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() };

  return {
    service: new AskBroadcastService(
      broadcastRepository as never,
      askRepository as never,
      askService as never,
      logger as never,
    ),
    broadcastRepository,
    askService,
    logger,
  };
}

describe('normalizeRecipients', () => {
  /**
   * Load-bearing, not tidiness. `asks_broadcast_responder_uniq` refuses a second
   * ask for the same person, and one failure does not sink the rest — so a
   * duplicate would DROP that person from the broadcast entirely.
   */
  it('dedupes, so a duplicate does not cost that person their ask', () => {
    expect(normalizeRecipients('me', ['a', 'b', 'a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('drops the asker rather than refusing the whole broadcast', () => {
    // Selecting yourself in a group picker is a slip, not an attack.
    expect(normalizeRecipients('me', ['a', 'me', 'b'])).toEqual(['a', 'b']);
  });

  it('drops blanks and non-strings', () => {
    expect(normalizeRecipients('me', ['a', '', '   ', null as never, 7 as never])).toEqual(['a']);
  });

  it('preserves the order the asker chose', () => {
    expect(normalizeRecipients('me', ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });
});

describe('AskBroadcastService.create', () => {
  it('creates one INDEPENDENT ask per recipient', async () => {
    const { service, askService } = makeService();

    const { members } = await service.create(OWNER, {
      responderUserIds: ['sam', 'dana', 'ana'],
      query: QUERY,
    });

    expect(members).toHaveLength(3);
    // Each goes through the ordinary submit, so each is evaluated against that
    // responder's own grants and capped by their own tier. Nothing about the
    // group changes what any one of them discloses.
    expect(askService.submit).toHaveBeenCalledTimes(3);
  });

  it('stamps ONE deadline on every child, so recipients are not racing clocks', async () => {
    const { service, askService } = makeService();

    await service.create(OWNER, { responderUserIds: ['sam', 'dana'], query: QUERY });

    const deadlines = askService.submit.mock.calls.map((call) => (call[1] as { expiresAt: Date }).expiresAt);
    expect(deadlines[0]).toEqual(deadlines[1]);
    expect(deadlines[0]).toBeInstanceOf(Date);
  });

  it('correlates every child with the broadcast', async () => {
    const { service, askService } = makeService();

    const { broadcast } = await service.create(OWNER, {
      responderUserIds: ['sam', 'dana'],
      query: QUERY,
    });

    for (const call of askService.submit.mock.calls) {
      expect((call[1] as { broadcastId: string }).broadcastId).toBe(broadcast.id);
    }
  });

  it(`refuses fewer than ${MIN_BROADCAST_RECIPIENTS} recipients — that is an ordinary ask`, async () => {
    const { service } = makeService();

    await expect(service.create(OWNER, { responderUserIds: ['sam'], query: QUERY })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // ...and a list that dedupes down to one is the same case.
    await expect(
      service.create(OWNER, { responderUserIds: ['sam', 'sam'], query: QUERY }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * An ABUSE CONTROL, not a cost bound. Each recipient is an ask in a HUMAN's
   * inbox, and the per-asker rate limit counts requests — this is one request.
   */
  it(`refuses more than ${MAX_BROADCAST_RECIPIENTS} recipients`, async () => {
    const { service, askService } = makeService();
    const many = Array.from({ length: MAX_BROADCAST_RECIPIENTS + 1 }, (_, i) => `p${i}`);

    await expect(service.create(OWNER, { responderUserIds: many, query: QUERY })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(askService.submit).not.toHaveBeenCalled();
  });

  it('accepts exactly the maximum', async () => {
    const { service } = makeService();
    const many = Array.from({ length: MAX_BROADCAST_RECIPIENTS }, (_, i) => `p${i}`);

    const { members } = await service.create(OWNER, { responderUserIds: many, query: QUERY });

    expect(members).toHaveLength(MAX_BROADCAST_RECIPIENTS);
  });

  /**
   * One stale id must not silently cancel a question the asker meant to put to
   * everybody else.
   */
  it('drops a recipient who cannot be asked and keeps the rest', async () => {
    const { service, logger } = makeService({ failFor: ['ghost'] });

    const { members } = await service.create(OWNER, {
      responderUserIds: ['sam', 'ghost', 'dana'],
      query: QUERY,
    });

    expect(members).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('removes the grouping row when NOBODY could be asked', async () => {
    // A broadcast of zero names a question nobody was asked.
    const { service, broadcastRepository } = makeService({ failFor: ['a', 'b'] });

    await expect(
      service.create(OWNER, { responderUserIds: ['a', 'b'], query: QUERY }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(broadcastRepository.delete).toHaveBeenCalled();
  });

  it('submits sequentially rather than fanning out against its own database', async () => {
    const { service, askService } = makeService();
    const order: string[] = [];
    askService.submit.mockImplementation(async (_ctx: unknown, dto: Record<string, unknown>) => {
      order.push(dto.responderUserId as string);

      return { ask: { id: `ask-${dto.responderUserId}` }, decision: 'review' };
    });

    await service.create(OWNER, { responderUserIds: ['a', 'b', 'c'], query: QUERY });

    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('AskBroadcastService.findForAsker', () => {
  /**
   * A responder has no business reading a broadcast: it would tell them who
   * ELSE was asked, which is a fact about the asker's relationships and a
   * third-party disclosure nobody consented to.
   */
  it('is asker-scoped, so a responder cannot learn who else was asked', async () => {
    const { service, broadcastRepository } = makeService();
    await service.create(OWNER, { responderUserIds: ['sam', 'dana'], query: QUERY });

    await service.findForAsker({ userId: 'sam' } as never, 'b1');

    expect(broadcastRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'b1', askerUserId: 'sam' },
    });
  });

  it('returns null for a broadcast the caller does not own', async () => {
    const { service, broadcastRepository } = makeService();
    broadcastRepository.findOne.mockResolvedValueOnce(null as never);

    expect(await service.findForAsker(OWNER, 'someone-elses')).toBeNull();
  });
});
