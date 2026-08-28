import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearJobsSnapshots } from './jobsSnapshots';
import {
  errorHeadline,
  groupDeadLetters,
  useDeadLetters,
  type DeadLetter,
  type DeadLettersResponse,
} from './useDeadLetters';

/**
 * The Jobs page's reader for `ci.pipeline_dead_letters`.
 *
 * What matters here is not "a hook fetches". It is that the card asks for the
 * REPLAY QUEUE (un-replayed only), that it groups 94 rows into the handful of
 * causes they really are, and that replay posts the ids the operator picked and
 * nothing else — the endpoint refuses an empty selector precisely so a UI bug
 * cannot turn a click into "re-emit everything".
 */

const h = vi.hoisted(() => ({ authToken: 'jwt-abc' as string | null, authenticated: true }));

// Native has no JWT — its credential is a keystore API key `fetchJson` attaches
// as `x-api-key` — so the gate is `authenticated`, not the bearer.
vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken, authenticated: h.authenticated }],
}));

const fetchJson = vi.hoisted(() => vi.fn());

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

function letter(overrides: Partial<DeadLetter> = {}): DeadLetter {
  return {
    id: 'letter-1',
    queue: 'dead-letter',
    eventName: 'infer.question.answer',
    stage: null,
    entityType: null,
    entityId: null,
    userId: null,
    payload: {},
    error: 'Invalid model specified: qwen/qwen3-vl-30b',
    failedAt: '2026-08-18T14:49:12.525Z',
    replayedAt: null,
    ...overrides,
  };
}

const EMPTY: DeadLettersResponse = { deadLetters: [] };

beforeEach(() => {
  h.authToken = 'jwt-abc';
  h.authenticated = true;
  clearJobsSnapshots();
  fetchJson.mockReset();
  fetchJson.mockResolvedValue(EMPTY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHeadline', () => {
  it('keeps only the message, because the stack embeds an absolute build path', () => {
    // Two occurrences of the same bug from different worktrees carry different
    // stacks; grouping on the whole string would never merge them.
    const error =
      'Invalid model specified: qwen/qwen3-vl-30b\n' +
      'Error: Invalid model specified: qwen/qwen3-vl-30b\n' +
      '    at OllamaService.validateModel (/Users/liam/devel/ci/CI-Server/…)';

    expect(errorHeadline(error)).toBe('Invalid model specified: qwen/qwen3-vl-30b');
  });

  it('never renders an empty cell', () => {
    expect(errorHeadline('   \n at somewhere')).toBe('Unknown error');
  });
});

describe('groupDeadLetters', () => {
  it('collapses repeats of one cause into a single counted row', () => {
    // The real shape: 36 of the appliance's 94 letters were this one config error.
    const letters = Array.from({ length: 36 }, (_, i) =>
      letter({ id: `letter-${i}`, error: `Invalid model specified: qwen/qwen3-vl-30b\n    at frame-${i}` }),
    );

    const [group] = groupDeadLetters(letters);

    expect(group.count).toBe(36);
    expect(group.ids).toHaveLength(36);
    expect(group.error).toBe('Invalid model specified: qwen/qwen3-vl-30b');
  });

  it('keeps the same message under different events apart', () => {
    // Replaying is per-listener; "fetch failed" under two events is two bugs.
    const groups = groupDeadLetters([
      letter({ id: 'a', eventName: 'file.uploaded', error: 'fetch failed' }),
      letter({ id: 'b', eventName: 'python.function.run', error: 'fetch failed' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('orders by most recent failure and reports the span', () => {
    const groups = groupDeadLetters([
      letter({ id: 'old', error: 'A', failedAt: '2026-08-01T00:00:00.000Z' }),
      letter({ id: 'older', error: 'A', failedAt: '2026-07-01T00:00:00.000Z' }),
      letter({ id: 'new', error: 'B', failedAt: '2026-08-18T00:00:00.000Z' }),
    ]);

    expect(groups.map((group) => group.error)).toEqual(['B', 'A']);
    expect(groups[1].firstFailedAt).toBe(new Date('2026-07-01T00:00:00.000Z').getTime());
    expect(groups[1].lastFailedAt).toBe(new Date('2026-08-01T00:00:00.000Z').getTime());
  });

  it('shows the newest occurrence’s full text as the detail', () => {
    const groups = groupDeadLetters([
      letter({ id: 'old', error: 'A\n old stack', failedAt: '2026-08-01T00:00:00.000Z' }),
      letter({ id: 'new', error: 'A\n new stack', failedAt: '2026-08-18T00:00:00.000Z' }),
    ]);

    expect(groups[0].detail).toBe('A\n new stack');
  });
});

describe('useDeadLetters', () => {
  it('asks for the replay queue only — replayed letters are done', async () => {
    renderHook(() => useDeadLetters(0));

    await waitFor(() => expect(fetchJson).toHaveBeenCalled());

    const [url] = fetchJson.mock.calls[0] as [string];

    expect(url).toContain('/api/pipeline/dead-letters');
    expect(url).toContain('replayed=false');
    expect(url).toContain('limit=200');
  });

  it('does not fetch without a session', async () => {
    h.authToken = null;
    h.authenticated = false;

    renderHook(() => useDeadLetters(0));

    await act(async () => {});

    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('fetches on native, which authenticates with a keystore key rather than a JWT', async () => {
    h.authToken = null;
    h.authenticated = true;

    renderHook(() => useDeadLetters(0));

    await waitFor(() => expect(fetchJson).toHaveBeenCalled());

    const [, init] = fetchJson.mock.calls[0] as [string, RequestInit];

    expect(init.headers).toEqual({});
  });

  it('shows the last replay queue on the first frame of a revisit', async () => {
    fetchJson.mockResolvedValue({ deadLetters: [letter()] });

    const first = renderHook(() => useDeadLetters(0));

    await waitFor(() => expect(first.result.current.groups).toHaveLength(1));
    first.unmount();

    const second = renderHook(() => useDeadLetters(0));

    // Before any fetch resolves — the card is a work queue and re-reading it
    // from zero every visit is what made the page feel like it had nothing.
    expect(second.result.current.groups).toHaveLength(1);
    expect(second.result.current.loading).toBe(false);
  });

  it('posts exactly the ids it was given to the bulk endpoint', async () => {
    fetchJson.mockResolvedValue({ deadLetters: [letter()] });

    const { result } = renderHook(() => useDeadLetters(0));

    await waitFor(() => expect(result.current.groups).toHaveLength(1));

    fetchJson.mockResolvedValueOnce({
      requested: 2,
      claimed: 2,
      limit: 50,
      replayed: [{ id: 'a', jobIds: ['job-1'] }],
      failed: [],
      skipped: [],
    });

    await act(async () => {
      await result.current.replay(['a', 'b']);
    });

    const post = fetchJson.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );

    expect(post).toBeDefined();

    const [postUrl, postInit] = post as [string, RequestInit];

    expect(postUrl).toBe('/api/pipeline/dead-letters/replay');
    expect(JSON.parse(postInit.body as string)).toEqual({ ids: ['a', 'b'] });
  });

  it('never posts an empty selector — that is the "replay everything" the API refuses', async () => {
    const { result } = renderHook(() => useDeadLetters(0));

    await waitFor(() => expect(fetchJson).toHaveBeenCalled());
    fetchJson.mockClear();

    await act(async () => {
      await expect(result.current.replay([])).resolves.toBeNull();
    });

    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('reloads after a replay so replayed causes leave the queue', async () => {
    fetchJson.mockResolvedValue({ deadLetters: [letter()] });

    const { result } = renderHook(() => useDeadLetters(0));

    await waitFor(() => expect(result.current.groups).toHaveLength(1));

    fetchJson.mockResolvedValueOnce({
      requested: 1,
      claimed: 1,
      limit: 50,
      replayed: [{ id: 'letter-1', jobIds: ['job-1'] }],
      failed: [],
      skipped: [],
    });
    fetchJson.mockResolvedValueOnce(EMPTY);

    await act(async () => {
      await result.current.replay(['letter-1']);
    });

    await waitFor(() => expect(result.current.groups).toHaveLength(0));
  });

  it('surfaces a load failure instead of rendering an empty queue as "all clear"', async () => {
    fetchJson.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useDeadLetters(0));

    await waitFor(() => expect(result.current.error).toBe('boom'));
  });
});
