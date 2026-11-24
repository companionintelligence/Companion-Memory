/**
 * The flush loop keeps trying while the app is in the foreground.
 *
 * Its two triggers fire on TRANSITIONS: the mode entering "connected", and a
 * resume. On 2026-10-16 a drain that had been cut short after five sends left
 * sixty-six fixes queued for twenty-three foreground minutes with a working
 * tunnel, because the mode then held steady and nothing re-ran the loop. The
 * provider now re-drains on a timer while connected with rows pending — and a
 * tick's failures do not spend the rows' attempt budget, or a flapping tunnel
 * would park every row in `needs_attention` within a few minutes.
 */
import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
// vitest hoists every `vi.mock` above the imports, so the mocks below are in
// place before this module loads.
import {
  OUTBOX_REDRAIN_INTERVAL_MS,
  OutboxQueueProvider,
  useOutboxQueue,
} from '@ci/common/src/utils/outboxFlush';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const items = new Map<
    string,
    { id: string; seq: number; kind: string; status: string; attempts: number; owner: null }
  >();

  return {
    items,
    listOutbox: vi.fn(async (status: string) => {
      const all = [...items.values()];
      const pending = all.filter((item) => item.status === 'pending');

      return {
        ok: true as const,
        value: {
          items: status === 'pending' ? pending : all,
          counts: { pending: pending.length, needsAttention: 0, total: all.length },
          capacity: { max: 5000, used: all.length, warnAt: 4000 },
        },
      };
    }),
    getOutboxItem: vi.fn(async (id: string) => {
      const item = items.get(id);

      return item
        ? {
            ok: true as const,
            value: { ...item, payload: { records: [] }, capturedAt: '2026-10-16T00:00:00Z' },
          }
        : { ok: false as const, reason: 'not_found' as const, message: 'gone' };
    }),
    recordOutboxAttempt: vi.fn(async (id: string, outcome: { ok: boolean }) => {
      if (outcome.ok) {
        items.delete(id);

        return { ok: true as const, value: null };
      }

      const item = items.get(id);

      if (item) {
        item.attempts += 1;
      }

      return { ok: true as const, value: item ?? null };
    }),
    fetchJson: vi.fn(),
  };
});

vi.mock('@ci/common/src/utils/connectionMode', () => ({
  useConnectionMode: () => ({ mode: 'connected', refresh: vi.fn(), isResolved: true, contractNotice: null }),
}));

vi.mock('@ci/common/src/utils/outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common/src/utils/outbox')>()),
  listOutbox: h.listOutbox,
  getOutboxItem: h.getOutboxItem,
  recordOutboxAttempt: h.recordOutboxAttempt,
}));

vi.mock('@ci/common/src/utils/fetchJson', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common/src/utils/fetchJson')>()),
  fetchJson: h.fetchJson,
}));

function Pending() {
  const { pending } = useOutboxQueue();

  return <span data-testid="pending">{pending}</span>;
}

/** Let the drain's promise chain run to the end under fake timers. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  setApiKey('device-key');
  setApiBaseUrl('http://appliance.test');
  h.items.clear();
  h.items.set('a', { id: 'a', seq: 1, kind: 'positions', status: 'pending', attempts: 0, owner: null });
  h.items.set('b', { id: 'b', seq: 2, kind: 'positions', status: 'pending', attempts: 0, owner: null });
  h.fetchJson.mockReset();
  h.recordOutboxAttempt.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  setApiKey(null);
  setApiBaseUrl('');
});

describe('outbox re-drain tick', () => {
  it('retries a row whose send failed, on the tick, without spending its attempts', async () => {
    // The appliance refuses a's first two sends (the first drain, then the first tick),
    // then accepts everything.
    let aRefusals = 2;
    h.fetchJson.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path.includes('/positions') && init?.body != null) {
        // The item being sent is the one whose payload is on the wire; the mock sidecar
        // hands every item the same payload, so tell them apart by order: a goes first.
        if (aRefusals > 0 && h.items.has('a') && h.getOutboxItem.mock.lastCall?.[0] === 'a') {
          aRefusals -= 1;
          throw new Error('tunnel dropped');
        }
      }

      return {};
    });

    render(
      <OutboxQueueProvider args={[]}>
        <Pending />
      </OutboxQueueProvider>,
    );
    await settle();

    // First drain, on entering "connected": a failed and spent an attempt; b went.
    expect(h.items.has('b')).toBe(false);
    expect(h.items.get('a')?.attempts).toBe(1);
    expect(screen.getByTestId('pending')).toHaveTextContent('1');

    // First tick: a fails again, but a tick's failure costs nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTBOX_REDRAIN_INTERVAL_MS);
    });
    await settle();

    expect(h.items.get('a')?.attempts).toBe(1);
    expect(h.recordOutboxAttempt.mock.calls.filter(([, outcome]) => !outcome.ok)).toHaveLength(1);

    // Second tick: a goes, and the queue reads empty.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTBOX_REDRAIN_INTERVAL_MS);
    });
    await settle();

    expect(h.items.size).toBe(0);
    expect(screen.getByTestId('pending')).toHaveTextContent('0');
  });

  it('does not tick once nothing is pending', async () => {
    h.fetchJson.mockResolvedValue({});

    render(
      <OutboxQueueProvider args={[]}>
        <Pending />
      </OutboxQueueProvider>,
    );
    await settle();
    expect(h.items.size).toBe(0);

    const listingsAfterDrain = h.listOutbox.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTBOX_REDRAIN_INTERVAL_MS * 3);
    });
    await settle();

    // No further pending listing: the timer is not running against an empty queue.
    expect(h.listOutbox.mock.calls.filter(([status]) => status === 'pending')).toHaveLength(
      h.listOutbox.mock.calls.slice(0, listingsAfterDrain).filter(([status]) => status === 'pending').length,
    );
  });
});
