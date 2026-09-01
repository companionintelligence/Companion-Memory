import { BrowserActivityInsightListener } from '../BrowserActivityInsightListener';

/**
 * `BrowserActivityInsightListener` fills in the two `BrowserActivityEntity`
 * columns ("AI-generated insights") that shipped with no producer:
 * `category` and `productivity_score`. `page_summary` is deliberately out of
 * scope — see the listener's class doc.
 *
 * These tests are the witness for the design decisions that came out of
 * review: a closed category taxonomy (never LLM free text), a
 * category-derived score (never a second LLM float), a same-URL cache window
 * that skips the LLM call entirely on a revisit, a privacy gate that never
 * even reads the preference for incognito/sensitive rows, and a URL sent to
 * the model with its query string and fragment stripped.
 */

const USER = 'user-1';
const ACTIVITY_ID = 'activity-1';

function makeListener(
  opts: {
    activity?: Record<string, unknown> | null;
    recentCategorized?: { category: string; productivity_score: number } | null;
    chatContent?: string;
    preferenceEnabled?: boolean;
  } = {},
) {
  const {
    activity = {
      id: ACTIVITY_ID,
      user_id: USER,
      url: 'https://github.com/companionintelligence/CI-Server/pull/1?tab=files#diff-1',
      title: 'A pull request',
      time: new Date('2026-08-29T12:00:00.000Z'),
      is_incognito: false,
      contains_sensitive: false,
    },
    recentCategorized = null,
    chatContent = JSON.stringify({ category: 'development' }),
    preferenceEnabled = true,
  } = opts;

  const browserActivityService = {
    findById: jest.fn(async () => activity),
    findMostRecentCategorized: jest.fn(async () => recentCategorized),
    update: jest.fn(async () => ({})),
  };

  const ollamaService = {
    chat: jest.fn(
      async (_context: unknown, _messages: Array<{ role: string; content: string }>, _options: unknown) => ({
        message: { content: chatContent },
      }),
    ),
  };

  const preference = {
    isEnabled: jest.fn(async () => preferenceEnabled),
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new BrowserActivityInsightListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    browserActivityService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ollamaService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    preference as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { listener, browserActivityService, ollamaService, preference, logger };
}

function payload(overrides: Record<string, unknown> = {}) {
  return { browserActivityId: ACTIVITY_ID, ...overrides };
}

describe('BrowserActivityInsightListener', () => {
  it('does nothing when the browser activity cannot be found', async () => {
    const { listener, ollamaService, preference } = makeListener({ activity: null });

    await listener.handle(payload());

    expect(preference.isEnabled).not.toHaveBeenCalled();
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('never checks the preference or calls the model for an incognito visit', async () => {
    const { listener, ollamaService, preference } = makeListener({
      activity: {
        id: ACTIVITY_ID,
        user_id: USER,
        url: 'https://example.com/private',
        title: 'Private',
        time: new Date(),
        is_incognito: true,
        contains_sensitive: false,
      },
    });

    await listener.handle(payload());

    expect(preference.isEnabled).not.toHaveBeenCalled();
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('never checks the preference or calls the model for a row flagged sensitive', async () => {
    const { listener, ollamaService, preference } = makeListener({
      activity: {
        id: ACTIVITY_ID,
        user_id: USER,
        url: 'https://example.com/sensitive',
        title: 'Sensitive',
        time: new Date(),
        is_incognito: false,
        contains_sensitive: true,
      },
    });

    await listener.handle(payload());

    expect(preference.isEnabled).not.toHaveBeenCalled();
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('skips quietly when the preference is disabled', async () => {
    const { listener, ollamaService, browserActivityService } = makeListener({ preferenceEnabled: false });

    await listener.handle(payload());

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('reuses a recent category for the same URL instead of calling the model', async () => {
    const { listener, ollamaService, browserActivityService } = makeListener({
      recentCategorized: { category: 'development', productivity_score: 0.9 },
    });

    await listener.handle(payload());

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(browserActivityService.update).toHaveBeenCalledWith(expect.anything(), ACTIVITY_ID, {
      category: 'development',
      productivity_score: 0.9,
    });
  });

  it('looks up the recent category within a 24h window of the visit, scoped to the user and URL', async () => {
    const { listener, browserActivityService } = makeListener();

    await listener.handle(payload());

    expect(browserActivityService.findMostRecentCategorized).toHaveBeenCalledWith(
      USER,
      'https://github.com/companionintelligence/CI-Server/pull/1?tab=files#diff-1',
      new Date('2026-08-28T12:00:00.000Z'),
    );
  });

  it('classifies via the model and derives the productivity score from the category', async () => {
    const { listener, browserActivityService } = makeListener({
      chatContent: JSON.stringify({ category: 'entertainment' }),
    });

    await listener.handle(payload());

    expect(browserActivityService.update).toHaveBeenCalledWith(expect.anything(), ACTIVITY_ID, {
      category: 'entertainment',
      productivity_score: 0.1,
    });
  });

  it('strips the query string and fragment from the URL before sending it to the model', async () => {
    const { listener, ollamaService } = makeListener();

    await listener.handle(payload());

    const [, messages] = ollamaService.chat.mock.calls[0]!;
    const content = messages[0].content as string;

    expect(content).toContain('https://github.com/companionintelligence/CI-Server/pull/1');
    expect(content).not.toContain('tab=files');
    expect(content).not.toContain('diff-1');
  });

  it('leaves the category unset when the model returns something outside the fixed taxonomy', async () => {
    const { listener, browserActivityService } = makeListener({
      chatContent: JSON.stringify({ category: 'productivity' }),
    });

    await listener.handle(payload());

    expect(browserActivityService.update).not.toHaveBeenCalled();
  });

  it('leaves the category unset when the model returns unparseable output', async () => {
    const { listener, browserActivityService } = makeListener({
      chatContent: 'not json',
    });

    await listener.handle(payload());

    expect(browserActivityService.update).not.toHaveBeenCalled();
  });
});
