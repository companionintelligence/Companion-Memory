import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopAppProvider } from '@/hooks';

import { DESKTOP_APP_CLOSED_NOTICE, DesktopAppClosedBanner } from './DesktopAppClosedBanner';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => [{ authToken: 'tok', authenticated: true, expired: false }, {}],
}));

/** What `GET /api/llm/desktop-app` answers, in order; the last one repeats. */
function answer(...bodies: Array<Record<string, unknown> | number>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = bodies.length > 1 ? bodies.shift() : bodies[0];

    expect(url).toMatch(/\/api\/llm\/desktop-app$/);

    if (typeof body === 'number') {
      return Promise.resolve(new Response('{"message":"Not Found"}', { status: body }));
    }

    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  });

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

function renderBanner() {
  render(
    <DesktopAppProvider args={[]}>
      <DesktopAppClosedBanner />
    </DesktopAppProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DesktopAppClosedBanner', () => {
  it('says Memory Desktop is closed and how to bring chat, search and summaries back', async () => {
    answer({ desktop: true, closed: true, message: 'Memory Desktop is closed.' });
    renderBanner();

    expect(await screen.findByTestId('desktop-app-closed-notice')).toHaveTextContent(
      DESKTOP_APP_CLOSED_NOTICE,
    );
  });

  it('goes away by itself once the app is open again', async () => {
    answer({ desktop: true, closed: true }, { desktop: true, closed: false });
    renderBanner();

    await screen.findByTestId('desktop-app-closed-notice');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await waitFor(() => expect(screen.queryByTestId('desktop-app-closed-notice')).toBeNull());
  });

  it('asks again on Check again', async () => {
    const fetchMock = answer({ desktop: true, closed: true });
    renderBanner();

    await screen.findByTestId('desktop-app-closed-notice');
    const calls = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Check again/ }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(calls + 1));
  });

  // Every Hub-managed Memory answers `desktop: false` once and is never asked again.
  it('stops asking off Memory Desktop', async () => {
    const fetchMock = answer({ desktop: false, closed: false });
    renderBanner();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('desktop-app-closed-notice')).toBeNull();
  });

  it('says nothing when the server has no such route', async () => {
    const fetchMock = answer(404);
    renderBanner();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('desktop-app-closed-notice')).toBeNull();
  });
});
