import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { CommunicationEntity } from '@ci/domains/memory';
import type { ContrastiveDecisionService } from '@ci/domains/model-routing';

import { InboxScanService } from '../InboxScanService';
import { TodoScanService } from '../TodoScanService';

const USER = '0190c3f2-0000-7000-8000-000000000001';
const FLAG = 'PLANNING_COMMITMENT_DECISION';
const CONTEXT = { userId: USER } as UserServiceContext;

const logger = {
  setContext: () => undefined,
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

function sidecarIngress(isCommitment: boolean, probability = isCommitment ? 0.8 : 0.1): Response {
  return new Response(
    JSON.stringify({
      user_id: USER,
      intent: isCommitment ? 'store_task' : 'conversational',
      intent_confidence: 0.6,
      intent_distribution: {},
      is_commitment: isCommitment,
      commitment_probability: probability,
      sensitivity: 0,
      sensitivity_distribution: {},
      calibrated: true,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A pre-filter that has a verdict: `actionable` true keeps the item, false drops it. */
function verdictService(actionable: boolean): ContrastiveDecisionService {
  return {
    scoreIngressCommitment: jest.fn(async () => ({
      isCommitment: actionable,
      probability: actionable ? 0.9 : 0.02,
      intent: 'store_task',
      sensitivity: 0,
      engineUsed: 'contrastive',
      latencyMs: 1,
    })),
  } as unknown as ContrastiveDecisionService;
}

function throwingService(): ContrastiveDecisionService {
  return {
    scoreIngressCommitment: jest.fn(async () => {
      throw new Error('pre-filter unavailable');
    }),
  } as unknown as ContrastiveDecisionService;
}

function inboxService(decisionService?: ContrastiveDecisionService): InboxScanService {
  return new InboxScanService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger,
    decisionService,
  );
}

function todoService(decisionService?: ContrastiveDecisionService): TodoScanService {
  return new TodoScanService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger,
    decisionService,
  );
}

/** Private methods, reached the way the scan reaches them. */
const inboxPrivate = (service: InboxScanService) =>
  service as unknown as {
    isSystem1NonActionable(ctx: UserServiceContext, message: unknown): Promise<boolean>;
  };
const todoPrivate = (service: TodoScanService) =>
  service as unknown as {
    filterSystem1ActionableHits(
      ctx: UserServiceContext,
      hits: Array<{ id: string; text: string }>,
    ): Promise<Array<{ id: string; text: string }>>;
  };

const MESSAGE = {
  id: 'msg-1',
  subject: 'Quarterly numbers',
  preview: 'Please send the deck by Friday',
} as unknown as CommunicationEntity;

describe('InboxScanService System 1 pre-filter with PLANNING_COMMITMENT_DECISION', () => {
  const previous = process.env[FLAG];

  afterEach(() => {
    jest.restoreAllMocks();

    if (previous === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = previous;
    }
  });

  it('is unchanged with the flag off: no pre-filter means keep, with no sidecar call', async () => {
    delete process.env[FLAG];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(inboxPrivate(inboxService()).isSystem1NonActionable(CONTEXT, MESSAGE)).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drops an undecided message when HBPE says it is not a commitment', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(sidecarIngress(false));

    await expect(inboxPrivate(inboxService()).isSystem1NonActionable(CONTEXT, MESSAGE)).resolves.toBe(true);

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];

    expect(JSON.parse(String(init.body))).toEqual({
      text: 'Quarterly numbers\nPlease send the deck by Friday',
    });
  });

  it('keeps an undecided message when HBPE says it is a commitment', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(sidecarIngress(true));

    await expect(inboxPrivate(inboxService()).isSystem1NonActionable(CONTEXT, MESSAGE)).resolves.toBe(false);
  });

  it('keeps an undecided message whose probability is at the threshold, as the pre-filter does', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(sidecarIngress(false, 0.3));

    await expect(inboxPrivate(inboxService()).isSystem1NonActionable(CONTEXT, MESSAGE)).resolves.toBe(false);
  });

  it('keeps a message whose text cannot be built, with no sidecar call', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const unreadable = { id: 'msg-2', subject: 'Odd', preview: 42 } as unknown as CommunicationEntity;

    await expect(inboxPrivate(inboxService()).isSystem1NonActionable(CONTEXT, unreadable)).resolves.toBe(
      false,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps an undecided message when the sidecar fails', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));

    await expect(inboxPrivate(inboxService()).isSystem1NonActionable(CONTEXT, MESSAGE)).resolves.toBe(false);
  });

  it('does not call the sidecar when the pre-filter has already decided', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      inboxPrivate(inboxService(verdictService(false))).isSystem1NonActionable(CONTEXT, MESSAGE),
    ).resolves.toBe(true);
    await expect(
      inboxPrivate(inboxService(verdictService(true))).isSystem1NonActionable(CONTEXT, MESSAGE),
    ).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a throwing pre-filter as undecided and asks HBPE', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(sidecarIngress(false));

    await expect(
      inboxPrivate(inboxService(throwingService())).isSystem1NonActionable(CONTEXT, MESSAGE),
    ).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TodoScanService System 1 pre-filter with PLANNING_COMMITMENT_DECISION', () => {
  const previous = process.env[FLAG];
  const HITS = [
    { id: 'hit-1', text: 'Your verification code is 918273' },
    { id: 'hit-2', text: 'Call the vet about Mochi' },
  ];

  afterEach(() => {
    jest.restoreAllMocks();

    if (previous === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = previous;
    }
  });

  it('keeps every hit with the flag off and no pre-filter, with no sidecar call', async () => {
    delete process.env[FLAG];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(todoPrivate(todoService()).filterSystem1ActionableHits(CONTEXT, HITS)).resolves.toEqual(
      HITS,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drops only the undecided hits that HBPE says are not commitments', async () => {
    process.env[FLAG] = 'true';
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarIngress(false))
      .mockResolvedValueOnce(sidecarIngress(true));

    await expect(todoPrivate(todoService()).filterSystem1ActionableHits(CONTEXT, HITS)).resolves.toEqual([
      HITS[1],
    ]);
  });

  it('keeps a hit whose probability is at the threshold, though is_commitment is false', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => sidecarIngress(false, 0.3));

    await expect(todoPrivate(todoService()).filterSystem1ActionableHits(CONTEXT, HITS)).resolves.toEqual(
      HITS,
    );
  });

  it('keeps the hits when the sidecar fails', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));

    await expect(todoPrivate(todoService()).filterSystem1ActionableHits(CONTEXT, HITS)).resolves.toEqual(
      HITS,
    );
  });

  it('applies the pre-filter verdict without calling the sidecar', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      todoPrivate(todoService(verdictService(false))).filterSystem1ActionableHits(CONTEXT, HITS),
    ).resolves.toEqual([]);
    await expect(
      todoPrivate(todoService(verdictService(true))).filterSystem1ActionableHits(CONTEXT, HITS),
    ).resolves.toEqual(HITS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
