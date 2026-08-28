import { ASK_TRANSITIONS, canTransitionAsk } from '../askStatus';
import type { AskStatus } from '../types';

import { AskExpiryService, EXPIRABLE_STATUSES, EXPIRY_BATCH_SIZE } from './AskExpiryService';

/**
 * ═══ `expires_at` WAS DECORATIVE ═══
 *
 * `expired` sat in the status union, in {@link ASK_TRANSITIONS} and on the
 * audit outcome enum from day one, and `ci.asks.expires_at` was written by
 * every caller that set a deadline — but nothing anywhere in apps/ or libs/
 * ever performed the transition. The consequence is not cosmetic: an ask in
 * `answering` is answerable by definition, and `AskService.complete`
 * deliberately does not re-check the standing grant on the owner-approved path.
 * An approved ask whose deadline passed yesterday was therefore a permanent,
 * revocation-immune authorization to disclose in full.
 */

const NOW = new Date('2026-08-20T12:00:00Z');
const YESTERDAY = new Date('2026-08-19T12:00:00Z');

function ask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ask-1',
    askerUserId: 'asker-1',
    peerLinkId: null,
    direction: 'local',
    responderUserId: 'responder-1',
    query: { queryType: 'photos', prompt: 'do you have photos of us?' },
    status: 'answering' as AskStatus,
    consentBasis: 'grant-auto',
    disclosureCeiling: null,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    expiresAt: YESTERDAY,
    ...overrides,
  };
}

function makeService(
  overdue: Record<string, unknown>[],
  options: { lockedAs?: Record<string, unknown> | null; auditThrows?: boolean } = {},
) {
  const askRepository = {
    find: jest.fn().mockResolvedValue(overdue),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => {
      if (options.lockedAs !== undefined) {
        return options.lockedAs;
      }

      return overdue.find((row) => row.id === where.id) ?? null;
    }),
    save: jest.fn().mockImplementation((row: unknown) => Promise.resolve(row)),
  };

  const auditService = {
    record: options.auditThrows
      ? jest.fn().mockRejectedValue(new Error('audit write failed'))
      : jest.fn().mockResolvedValue(undefined),
  };

  // Faithful enough: hands the body a manager and, like a real transaction,
  // does NOT swallow a rejection.
  const manager = { getRepository: jest.fn().mockReturnValue(askRepository) };
  const dataSource = {
    transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new AskExpiryService(
    askRepository as never,
    auditService as never,
    dataSource as never,
    logger as never,
  );

  return { service, askRepository, auditService, dataSource, manager, logger };
}

describe('the state machine has an edge to expire an approved ask', () => {
  it('permits answering → expired', () => {
    // The edge whose ABSENCE made `answering` the one state an ask could park
    // in forever: every other non-terminal state already had one.
    expect(canTransitionAsk('answering', 'expired')).toBe(true);
  });

  it('every expirable status has the edge, and no terminal status gained one', () => {
    for (const status of EXPIRABLE_STATUSES) {
      expect(canTransitionAsk(status, 'expired')).toBe(true);
    }

    for (const status of ['answered', 'declined', 'expired'] as AskStatus[]) {
      expect(ASK_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it('does not make expiry a way to un-answer an ask', () => {
    expect(canTransitionAsk('expired', 'answering')).toBe(false);
    expect(canTransitionAsk('expired', 'answered')).toBe(false);
  });
});

describe('AskExpiryService.sweep', () => {
  it('expires an ask parked in answering past its deadline — the revocation-immune case', async () => {
    const overdue = ask({ status: 'answering' });
    const { service, askRepository } = makeService([overdue]);

    expect(await service.sweep(NOW)).toBe(1);
    expect(overdue.status).toBe('expired');
    expect(askRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });

  it.each(['delivered', 'under_review', 'answering'] as const)('expires a %s ask', async (status) => {
    const overdue = ask({ status });
    const { service } = makeService([overdue]);

    await service.sweep(NOW);

    expect(overdue.status).toBe('expired');
  });

  it('audits the expiry as a terminal outcome, like a decline', async () => {
    // Declines are audited because the gate working is the point; an expiry is
    // the same gate closing on its own.
    const { service, auditService, manager } = makeService([ask()]);

    await service.sweep(NOW);

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        askId: 'ask-1',
        askerUserId: 'asker-1',
        responderUserId: 'responder-1',
        consentBasis: 'grant-auto',
        outcome: 'expired',
      }),
      // Enrolled in the sweep's transaction — an audit row on its own connection
      // could commit while the status change rolls back, and `expired` is
      // terminal so no retry could ever repair it.
      manager,
    );
  });

  it('writes the status change and the audit in ONE transaction', async () => {
    const { service, dataSource } = makeService([ask()]);

    await service.sweep(NOW);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('leaves the ask alone when the audit write fails', async () => {
    // The transaction stand-in propagates rather than committing each half, so
    // the observable contract is that the sweep reports zero and moves on.
    const overdue = ask();
    const { service, logger } = makeService([overdue], { auditThrows: true });

    expect(await service.sweep(NOW)).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('scans only the statuses that have an expiry edge', async () => {
    const { service, askRepository } = makeService([]);

    await service.sweep(NOW);

    const where = askRepository.find.mock.calls[0][0].where;
    expect(where.status._value).toEqual([...EXPIRABLE_STATUSES]);
    // `sent` is excluded on purpose: it has no expiry edge and does not survive
    // `AskService.create`, so a `sent` row past its deadline is a creation-path
    // bug, not something the sweep should invent an edge for.
    expect(where.status._value).not.toContain('sent');
  });

  it('never sweeps an ask with no deadline', async () => {
    const { service, askRepository } = makeService([]);

    await service.sweep(NOW);

    // A NULL never satisfies a SQL comparison, so `LessThan(now)` is the whole
    // guard — asserting the operator is asserting that behaviour.
    const where = askRepository.find.mock.calls[0][0].where;
    expect(where.expiresAt._type).toBe('lessThan');
    expect(where.expiresAt._value).toBe(NOW);
  });

  it('bounds one run so a long-idle appliance cannot open a transaction per row forever', async () => {
    const { service, askRepository } = makeService([]);

    await service.sweep(NOW);

    expect(askRepository.find.mock.calls[0][0].take).toBe(EXPIRY_BATCH_SIZE);
    // Oldest deadline first, so the most overdue authorizations go first.
    expect(askRepository.find.mock.calls[0][0].order).toEqual({ expiresAt: 'ASC' });
  });

  it('yields to a responder who decided between the scan and the lock', async () => {
    // The sweep read it as `answering`; by the time the row was locked the
    // owner had answered it. A real outcome beats a deadline, and re-expiring
    // it would be an illegal edge anyway.
    const scanned = ask({ status: 'answering' });
    const { service, auditService, askRepository, logger } = makeService([scanned], {
      lockedAs: ask({ status: 'answered' }),
    });

    expect(await service.sweep(NOW)).toBe(0);
    expect(askRepository.save).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    // A GRACEFUL yield, not an exception swallowed by the batch loop. Without
    // the re-check the illegal `answered → expired` edge throws, which reaches
    // the same counts but logs an error on every ordinary race and buries the
    // real failures the sweep is supposed to surface.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('yields when the ask vanished between the scan and the lock', async () => {
    const { service, auditService, logger } = makeService([ask()], { lockedAs: null });

    expect(await service.sweep(NOW)).toBe(0);
    expect(auditService.record).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('locks the row it is about to retire', async () => {
    const { service, askRepository } = makeService([ask()]);

    await service.sweep(NOW);

    expect(askRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('one bad row does not strand the rest of the batch', async () => {
    // A sweep that abandoned the batch on the first failure would leave every
    // ask behind it authorized — the exact state it exists to end.
    const good = ask({ id: 'ask-2', status: 'delivered' });
    const { service, askRepository, auditService } = makeService([ask({ id: 'ask-1' }), good]);
    auditService.record.mockRejectedValueOnce(new Error('boom'));
    askRepository.findOne.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'ask-1' ? ask({ id: 'ask-1' }) : good,
    );

    expect(await service.sweep(NOW)).toBe(1);
    expect(good.status).toBe('expired');
  });

  it('reports zero and does nothing when nothing is overdue', async () => {
    const { service, dataSource, auditService } = makeService([]);

    expect(await service.sweep(NOW)).toBe(0);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });
});
