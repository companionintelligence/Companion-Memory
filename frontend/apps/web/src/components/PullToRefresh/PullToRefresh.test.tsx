import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { PullToRefresh } from './PullToRefresh';

const originalMatchMedia = window.matchMedia;

function stubViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function list() {
  return (
    <div data-page-scroll="" data-testid="scroller" style={{ height: 200, overflow: 'auto' }}>
      <div style={{ height: 400 }}>People</div>
    </div>
  );
}

/** A page that pins its own scrollable region, the way Jobs pins live imports. */
function withInnerScroller() {
  return (
    <div data-page-scroll="" data-testid="scroller" style={{ height: 200, overflow: 'auto' }}>
      <div data-testid="inner" style={{ height: 100, overflow: 'auto' }}>
        <div style={{ height: 400 }}>import activity</div>
      </div>
      <div style={{ height: 400 }}>Jobs</div>
    </div>
  );
}

function pull(target: HTMLElement) {
  fireEvent.touchStart(target, { touches: [{ identifier: 0, clientY: 10 }] });
  fireEvent.touchMove(target, { touches: [{ identifier: 0, clientY: 160 }] });
  fireEvent.touchEnd(target);
}

describe('PullToRefresh', () => {
  it('is inert on desktop', () => {
    stubViewport(false);
    const onRefresh = vi.fn();

    renderWithProviders(<PullToRefresh onRefresh={onRefresh}>{list()}</PullToRefresh>);

    expect(screen.queryByTestId('pull-to-refresh')).not.toBeInTheDocument();
    fireEvent.touchStart(screen.getByTestId('scroller'), { touches: [{ clientY: 8 }] });
    fireEvent.touchMove(screen.getByTestId('scroller'), { touches: [{ clientY: 120 }] });
    fireEvent.touchEnd(screen.getByTestId('scroller'));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('refetches after a downward pull at the top of a Memory list', async () => {
    stubViewport(true);
    const onRefresh = vi.fn(() => Promise.resolve());

    renderWithProviders(<PullToRefresh onRefresh={onRefresh}>{list()}</PullToRefresh>);

    await screen.findByTestId('pull-to-refresh');

    pull(screen.getByTestId('scroller'));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  /**
   * WKWebView decides whether a touch sequence may cancel scrolling when the
   * sequence BEGINS. A host that rebuilds `onRefresh` between renders — Jobs
   * does, on every poll tick — used to tear the `{ passive: false }` touchmove
   * down and put a new one back; anything re-attached mid-gesture receives
   * `cancelable: false` events, so the pull never preventDefaults and the
   * webview rubber-bands while the indicator stays put.
   */
  it('keeps its touch listeners through a caller that rebuilds onRefresh', async () => {
    stubViewport(true);

    const remove = vi.spyOn(Element.prototype, 'removeEventListener');
    const { rerender } = renderWithProviders(
      <PullToRefresh onRefresh={() => Promise.resolve()}>{list()}</PullToRefresh>,
    );

    await screen.findByTestId('pull-to-refresh');
    remove.mockClear();

    rerender(<PullToRefresh onRefresh={() => Promise.resolve()}>{list()}</PullToRefresh>);

    expect(remove.mock.calls.filter(([type]) => type === 'touchmove')).toHaveLength(0);

    remove.mockRestore();
  });

  it('runs the newest onRefresh, not the one it was mounted with', async () => {
    stubViewport(true);

    const stale = vi.fn(() => Promise.resolve());
    const current = vi.fn(() => Promise.resolve());

    const { rerender } = renderWithProviders(<PullToRefresh onRefresh={stale}>{list()}</PullToRefresh>);

    await screen.findByTestId('pull-to-refresh');

    rerender(<PullToRefresh onRefresh={current}>{list()}</PullToRefresh>);
    pull(screen.getByTestId('scroller'));

    await waitFor(() => expect(current).toHaveBeenCalledTimes(1));
    expect(stale).not.toHaveBeenCalled();
  });

  it('leaves a drag inside a scrolled inner region alone', async () => {
    stubViewport(true);
    const onRefresh = vi.fn(() => Promise.resolve());

    renderWithProviders(<PullToRefresh onRefresh={onRefresh}>{withInnerScroller()}</PullToRefresh>);

    await screen.findByTestId('pull-to-refresh');

    const inner = screen.getByTestId('inner');
    // jsdom does no layout, so scrollTop is pinned at 0 unless it is declared.
    Object.defineProperty(inner, 'scrollTop', { configurable: true, value: 40 });

    pull(inner);

    // The page scroller is at its top, but the finger is on a card that is
    // not — refreshing here would also swallow the scroll that was asked for.
    await waitFor(() => expect(screen.getByTestId('pull-to-refresh')).toHaveAttribute('aria-hidden', 'true'));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  // The phone drawer claims a sideways drag by cancelling its touchmove in the
  // capture phase. A drawer drag that drifts down on its way across must not
  // also count as a pull.
  it('leaves a touch alone once another gesture has cancelled it', async () => {
    stubViewport(true);
    const onRefresh = vi.fn(() => Promise.resolve());

    renderWithProviders(<PullToRefresh onRefresh={onRefresh}>{list()}</PullToRefresh>);

    await screen.findByTestId('pull-to-refresh');

    const claim = (event: TouchEvent) => event.preventDefault();
    document.addEventListener('touchmove', claim, { capture: true, passive: false });

    try {
      pull(screen.getByTestId('scroller'));
    } finally {
      document.removeEventListener('touchmove', claim, { capture: true });
    }

    expect(screen.getByTestId('pull-to-refresh')).toHaveAttribute('aria-hidden', 'true');
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
