import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLoadMoreSentinel } from './useLoadMoreSentinel';

type Callback = IntersectionObserverCallback;

/** Captures the observers the hook builds so a test can fire them. */
function stubObserver() {
  const observers: Array<{
    callback: Callback;
    options: IntersectionObserverInit | undefined;
    disconnect: () => void;
  }> = [];

  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: Callback, options?: IntersectionObserverInit) {
        observers.push({ callback, options, disconnect: vi.fn() });
      }

      observe = vi.fn();

      disconnect() {
        observers[observers.length - 1]?.disconnect();
      }
    },
  );

  return observers;
}

function withSentinel(options: Parameters<typeof useLoadMoreSentinel>[0]) {
  const sentinel = document.createElement('div');

  return renderHook(
    (props: Parameters<typeof useLoadMoreSentinel>[0]) => {
      const ref = useLoadMoreSentinel(props);
      ref.current = sentinel;

      return ref;
    },
    { initialProps: options },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useLoadMoreSentinel', () => {
  it('asks for the next page when the sentinel comes into view, and not before', () => {
    const observers = stubObserver();
    const loadMore = vi.fn();
    const root = { current: document.createElement('div') };

    withSentinel({ enabled: true, loadMore, root, rootMargin: '600px' });

    expect(observers).toHaveLength(1);
    expect(observers[0].options).toEqual({ root: root.current, rootMargin: '600px' });

    observers[0].callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(loadMore).not.toHaveBeenCalled();

    observers[0].callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it('watches nothing while disabled, and stops watching once disabled', () => {
    const observers = stubObserver();
    const loadMore = vi.fn();

    const { rerender } = withSentinel({ enabled: false, loadMore });
    expect(observers).toHaveLength(0);

    rerender({ enabled: true, loadMore });
    expect(observers).toHaveLength(1);

    rerender({ enabled: false, loadMore });
    expect(observers[0].disconnect).toHaveBeenCalled();
    expect(observers).toHaveLength(1);
  });
});
