/**
 * What the connection chip actually tells the user, driven through the real
 * provider and a real (faked) health endpoint.
 *
 * `connectionMode.test.ts` covers the resolver in isolation — given a set of
 * probes, the right mode comes out. What is asserted here is the part a user
 * reads off the screen, and both cases below were wrong in the same
 * deployment: an appliance reached over a Cloudflare tunnel answers
 * /api/health in ~650ms, which the old single 500ms probe budget aborted, so
 * the chip claimed "Not synced yet" against a server the rest of the app was
 * using without trouble — and, since the mode was resolved once at mount, it
 * kept claiming it for the life of the page.
 */

import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import {
  CONNECTION_REPROBE_INTERVAL_MS,
  CONNECTION_RESOLVE_TIMEOUT_MS,
  ConnectionModeProvider,
} from '@ci/common/src/utils/connectionMode';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionModeIndicator } from '@/components/ConnectionModeIndicator';

import { okResponse, slowServer } from './fetchFakes';

/** Slower than an on-device sidecar should ever be — the tunnel's real latency. */
const TUNNEL_LATENCY_MS = 650;

/**
 * The one case here that waits on a real timer. `waitFor`'s 1s default leaves
 * only ~300ms of headroom over the latency being simulated, which is not enough
 * on a loaded CI runner — the budget is stated explicitly rather than inherited.
 */
const SLOW_SERVER_WAIT_MS = 5_000;

function renderIndicator() {
  return render(
    <ConnectionModeProvider args={[]}>
      <ConnectionModeIndicator />
    </ConnectionModeProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setApiBaseUrl('');
  setApiKey(null);
});

describe('ConnectionModeIndicator', () => {
  it('reports "Connected" for a remote that answers slower than an on-device server would', async () => {
    vi.stubGlobal('fetch', slowServer(TUNNEL_LATENCY_MS));

    renderIndicator();

    // "Connected" is the one mode kept to just the dot, so the label is present
    // for screen readers only — the chip is found by its accessible name.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connected' })).toBeInTheDocument(), {
      timeout: SLOW_SERVER_WAIT_MS,
    });
    expect(screen.queryByText('Not synced yet')).not.toBeInTheDocument();
  });

  it('renders nothing until the first probe settles, rather than asserting "Not synced yet" on load', async () => {
    let release: (() => void) | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return okResponse();
      }),
    );

    const { container } = renderIndicator();

    // The pre-probe mode is "fresh"; showing it would tell the user the app has
    // never synced, moments before the health check says otherwise.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Not synced yet')).not.toBeInTheDocument();

    release?.();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connected' })).toBeInTheDocument());
  });

  it('explains what the icon means on a tap, which is the only on-screen account of it', async () => {
    // This file's `unstubAllGlobals` also clears the ResizeObserver stub that
    // setup.ts installs once at import, and Radix's positioning needs it — so
    // the tooltip's own case puts it back.
    class ResizeObserverStub {
      observe() {}

      unobserve() {}

      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse()),
    );

    renderIndicator();

    const chip = await screen.findByRole('button', { name: 'Connected' });

    // A tap, not a hover: on a phone the hover tooltip this used to be opened
    // on the tap's focus and closed on its click, a flash.
    fireEvent.click(chip);

    const popover = await screen.findByTestId('connection-mode-popover');

    expect(popover).toHaveTextContent('Your Companion server is answering');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('reports "Not synced yet" once a genuinely unreachable server has been probed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    renderIndicator();

    await waitFor(() => expect(screen.getByText('Not synced yet')).toBeInTheDocument());
  });

  it('re-probes on the interval, so a mode resolved once at mount cannot pin the chip', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderIndicator();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The appliance going away (or coming back) while the network stays up
    // raises neither `online` nor `offline`; only the timer catches it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECTION_REPROBE_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from a probe that never settles instead of hiding the chip for the life of the page', async () => {
    vi.useFakeTimers();

    // Answers its headers and then stalls forever, and the body ignores the
    // probe's abort signal, so nothing inside the probe can end this.
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve({ ok: true, status: 200, text: () => new Promise(() => {}) } as unknown as Response),
            10,
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderIndicator();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECTION_RESOLVE_TIMEOUT_MS - 100);
    });
    expect(container).toBeEmptyDOMElement();

    // The outer bound settles the hung resolve as "fresh"...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('Not synced yet')).toBeInTheDocument();

    // ...and, crucially, leaves the hook able to probe again: a wedged
    // in-flight ref would make every later tick a silent no-op.
    const callsSoFar = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECTION_REPROBE_INTERVAL_MS);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsSoFar);
  });
});
