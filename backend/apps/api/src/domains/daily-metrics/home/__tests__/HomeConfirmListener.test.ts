import type { LoggerService } from '@ci/common/logging';
import type { Acknowledgement } from '@ci/domains/events';
import type { AnswerCreatedPayload } from '@ci/domains/intelligence/events';

import type { DailyMetricsService } from '../../services/DailyMetricsService';
import { HOME_QUESTION_ID } from '../homeConfirm';
import { HomeConfirmListener } from '../HomeConfirmListener';
import type { HomeConfirmService } from '../HomeConfirmService';

const ANSWER_ID = 'answer-1';
const USER_ID = 'user-1';

type AnswerRow = { user_id: string; question_id: string; text: string | null };

function makeLogger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

function makeAck(): Acknowledgement {
  return { jobId: 'test-job', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

function buildListener(
  overrides: {
    rows?: AnswerRow[];
    homeConfirm?: Partial<HomeConfirmService>;
    dailyMetrics?: Partial<DailyMetricsService>;
  } = {},
) {
  const rows = overrides.rows ?? [{ user_id: USER_ID, question_id: HOME_QUESTION_ID, text: 'yes' }];
  const query = jest.fn().mockResolvedValue(rows);
  const dataSource = { query } as never;

  const homeConfirm = {
    confirmFromResponse: jest.fn().mockResolvedValue(true),
    ...overrides.homeConfirm,
  } as unknown as HomeConfirmService;

  const dailyMetrics = {
    refreshForUser: jest.fn().mockResolvedValue([]),
    ...overrides.dailyMetrics,
  } as unknown as DailyMetricsService;

  const logger = makeLogger();

  const listener = new HomeConfirmListener(dataSource, homeConfirm, dailyMetrics, logger);

  // @OnEvent wraps the descriptor at class-definition time, so calling the
  // method here already goes through its autoAcknowledge try/catch — the same
  // path pg-boss drives with a real ack. See OnEvent.test.ts for the contract:
  // the handler settles ack.done()/ack.fail() and never rethrows to the caller.
  const call = (payload: AnswerCreatedPayload, ack: Acknowledgement) =>
    (
      listener as unknown as {
        onAnswerCreated: (p: AnswerCreatedPayload, a: Acknowledgement) => Promise<void>;
      }
    ).onAnswerCreated(payload, ack);

  return { call, query, homeConfirm, dailyMetrics, logger };
}

describe('HomeConfirmListener.onAnswerCreated', () => {
  it('skips when the answer row cannot be found', async () => {
    const { call, homeConfirm } = buildListener({ rows: [] });
    const ack = makeAck();

    await call({ answerId: ANSWER_ID } as AnswerCreatedPayload, ack);

    expect(homeConfirm.confirmFromResponse).not.toHaveBeenCalled();
    expect(ack.done).toHaveBeenCalledTimes(1);
  });

  it('skips answers to a question other than the seeded home question', async () => {
    const { call, homeConfirm } = buildListener({
      rows: [{ user_id: USER_ID, question_id: 'some-other-question', text: 'yes' }],
    });
    const ack = makeAck();

    await call({ answerId: ANSWER_ID } as AnswerCreatedPayload, ack);

    expect(homeConfirm.confirmFromResponse).not.toHaveBeenCalled();
    expect(ack.done).toHaveBeenCalledTimes(1);
  });

  it('skips blank/whitespace-only answer text', async () => {
    const { call, homeConfirm } = buildListener({
      rows: [{ user_id: USER_ID, question_id: HOME_QUESTION_ID, text: '   ' }],
    });
    const ack = makeAck();

    await call({ answerId: ANSWER_ID } as AnswerCreatedPayload, ack);

    expect(homeConfirm.confirmFromResponse).not.toHaveBeenCalled();
    expect(ack.done).toHaveBeenCalledTimes(1);
  });

  it('looks up the answer by id and confirms home for the matching user', async () => {
    const { call, query, homeConfirm } = buildListener();
    const ack = makeAck();

    await call({ answerId: ANSWER_ID } as AnswerCreatedPayload, ack);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM ci.answers'), [ANSWER_ID]);
    expect(homeConfirm.confirmFromResponse).toHaveBeenCalledWith({ userId: USER_ID }, 'yes');
    expect(ack.done).toHaveBeenCalledTimes(1);
  });

  it('refreshes daily metrics when confirmFromResponse actually wrote a place', async () => {
    const { call, dailyMetrics } = buildListener({
      homeConfirm: { confirmFromResponse: jest.fn().mockResolvedValue(true) },
    });

    await call({ answerId: ANSWER_ID } as AnswerCreatedPayload, makeAck());

    expect(dailyMetrics.refreshForUser).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it('does not refresh daily metrics when confirmFromResponse declined to write', async () => {
    const { call, dailyMetrics } = buildListener({
      homeConfirm: { confirmFromResponse: jest.fn().mockResolvedValue(false) },
    });

    await call({ answerId: ANSWER_ID } as AnswerCreatedPayload, makeAck());

    expect(dailyMetrics.refreshForUser).not.toHaveBeenCalled();
  });

  it('fails the job instead of acking it done when confirmFromResponse throws', async () => {
    // The bug: an inner catch that logged and returned let originalMethod
    // resolve, so OnEvent's autoAcknowledge wrapper called ack.done() even
    // though the home-confirmation write never happened. Rethrowing routes it
    // to ack.fail() instead, so pg-boss actually retries the job.
    const writeError = new Error('db write failed');
    const { call, logger } = buildListener({
      homeConfirm: { confirmFromResponse: jest.fn().mockRejectedValue(writeError) },
    });
    const ack = makeAck();

    await expect(call({ answerId: ANSWER_ID } as AnswerCreatedPayload, ack)).resolves.toBeUndefined();

    expect(ack.fail).toHaveBeenCalledTimes(1);
    expect(ack.fail).toHaveBeenCalledWith(writeError);
    expect(ack.done).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Home confirm from answer failed',
      expect.objectContaining({ answerId: ANSWER_ID }),
    );
  });
});
