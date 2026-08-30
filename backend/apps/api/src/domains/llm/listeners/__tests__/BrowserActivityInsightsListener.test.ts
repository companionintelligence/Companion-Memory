import { BrowserActivityInsightsListener } from '../BrowserActivityInsightsListener';

/**
 * `BrowserActivityInsightsListener` — the producer for `browser_activity.category`
 * and `.productivity_score`, two columns that carried an "AI-generated
 * insights" comment since the entity was written but had no producer at all
 * (a prior audit found every reference in the codebase was a type definition
 * or a straight DTO field-copy). These tests are the witness that a real
 * producer now exists, and that it respects the guards documented on the
 * listener: private rows are skipped, already-categorized rows are left
 * alone, and a bad LLM response never throws or half-writes the row.
 */

const ACTIVITY_ID = 'activity-1';
const USER_ID = 'user-1';

function baseActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTIVITY_ID,
    user_id: USER_ID,
    url: 'https://docs.example.com/guides/getting-started',
    title: 'Getting Started — Example Docs',
    action_type: 'visit',
    is_incognito: false,
    contains_sensitive: false,
    category: null,
    productivity_score: null,
    ...overrides,
  };
}

const VALID_INSIGHT = JSON.stringify({ category: 'reference', productivity_score: 0.8 });

function makeListener(opts: { activity?: Record<string, unknown> | null; content?: string } = {}) {
  const { activity = baseActivity(), content = VALID_INSIGHT } = opts;

  const browserActivityService = {
    findById: jest.fn(async (_ctx: unknown, _id: string) => activity),
    update: jest.fn(async (_ctx: unknown, _id: string, _data: unknown) => activity),
  };

  const ollamaService = {
    chat: jest.fn(async (_ctx: unknown, _messages: unknown, _options: unknown) => ({
      message: { content },
    })),
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new BrowserActivityInsightsListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    browserActivityService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ollamaService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { listener, browserActivityService, ollamaService, logger };
}

function payload(overrides: Record<string, unknown> = {}) {
  return { browserActivityId: ACTIVITY_ID, ...overrides };
}

describe('BrowserActivityInsightsListener', () => {
  it('classifies a page visit and writes category/productivity_score back onto the row', async () => {
    const { listener, ollamaService, browserActivityService } = makeListener();

    await listener.handle(payload());

    expect(ollamaService.chat).toHaveBeenCalledTimes(1);

    const [, , options] = ollamaService.chat.mock.calls[0];

    // Text-only background classification uses UTILITY_MODEL directly (the
    // ConceptExtractionService/TaskBreakdownService convention), not
    // resolveModel — this call carries no image, so there is no vision
    // capability to resolve for.
    expect(options).toEqual(
      expect.objectContaining({
        model: expect.any(String),
        enableTools: false,
        format: expect.objectContaining({ type: 'object' }),
      }),
    );

    expect(browserActivityService.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: expect.anything() }),
      ACTIVITY_ID,
      { category: 'reference', productivity_score: 0.8 },
    );
  });

  it('sends the url, title and action_type to the model — the only evidence it has', async () => {
    const { listener, ollamaService } = makeListener();

    await listener.handle(payload());

    const [, messages] = ollamaService.chat.mock.calls[0];
    const prompt: string = (messages as Array<{ content: string }>)[0].content;

    expect(prompt).toContain('https://docs.example.com/guides/getting-started');
    expect(prompt).toContain('Getting Started — Example Docs');
    expect(prompt).toContain('visit');
  });

  it('does nothing when the row cannot be found', async () => {
    const { listener, ollamaService, browserActivityService } = makeListener({ activity: null });

    await listener.handle(payload());

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('skips incognito rows without ever calling the model', async () => {
    const { listener, ollamaService, browserActivityService } = makeListener({
      activity: baseActivity({ is_incognito: true }),
    });

    await listener.handle(payload());

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('skips rows flagged contains_sensitive without ever calling the model', async () => {
    const { listener, ollamaService, browserActivityService } = makeListener({
      activity: baseActivity({ contains_sensitive: true }),
    });

    await listener.handle(payload());

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('skips rows with no URL', async () => {
    const { listener, ollamaService, browserActivityService } = makeListener({
      activity: baseActivity({ url: '' }),
    });

    await listener.handle(payload());

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('skips rows that already have a category — idempotent, and non-destructive toward another producer', async () => {
    const { listener, ollamaService, browserActivityService } = makeListener({
      activity: baseActivity({ category: 'work' }),
    });

    await listener.handle(payload());

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('never generates page_summary — leaves the bulk-importer-owned column alone', async () => {
    const { listener, browserActivityService } = makeListener();

    await listener.handle(payload());

    const [, , update] = browserActivityService.update.mock.calls[0];

    expect(update).not.toHaveProperty('page_summary');
  });

  it('writes nothing when the model response fails schema validation', async () => {
    const { listener, browserActivityService } = makeListener({
      content: JSON.stringify({ category: 'not-a-real-category', productivity_score: 0.5 }),
    });

    await listener.handle(payload());

    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('writes nothing when productivity_score is out of the 0..1 range', async () => {
    const { listener, browserActivityService } = makeListener({
      content: JSON.stringify({ category: 'work', productivity_score: 1.4 }),
    });

    await listener.handle(payload());

    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('writes nothing when the model returns unparseable output', async () => {
    const { listener, browserActivityService } = makeListener({
      content: 'I am afraid I cannot do that.',
    });

    await listener.handle(payload());

    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('writes nothing when the model returns an empty response', async () => {
    const { listener, browserActivityService } = makeListener({ content: '' });

    await listener.handle(payload());

    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('swallows an LLM call failure rather than throwing — a queued job should not dead-letter on a down backend', async () => {
    const { listener, browserActivityService, ollamaService } = makeListener();

    ollamaService.chat.mockRejectedValueOnce(new Error('backend unreachable'));

    await expect(listener.handle(payload())).resolves.toBeUndefined();
    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('tolerates a markdown-fenced JSON response', async () => {
    const { listener, browserActivityService } = makeListener({
      content: '```json\n' + VALID_INSIGHT + '\n```',
    });

    await listener.handle(payload());

    expect(browserActivityService.update).toHaveBeenCalledWith(expect.anything(), ACTIVITY_ID, {
      category: 'reference',
      productivity_score: 0.8,
    });
  });
});
