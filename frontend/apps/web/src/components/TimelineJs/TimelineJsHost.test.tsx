import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineJsHost } from './TimelineJsHost';
import type { TimelineJsData } from './types';

/**
 * A stand-in for Knight Lab's constructor with the one trait that matters
 * here: `config` is null until an asynchronous load completes, and `add()`
 * dereferences it unguarded — exactly the shape that threw
 * "Cannot read properties of null (reading 'addEvent')" on a cold load.
 */
class FakeTimeline {
  static instances: FakeTimeline[] = [];

  ready = false;

  config: { events: Array<{ unique_id?: string }> } | null = null;

  current_id?: string;

  add = vi.fn((slide: { unique_id?: string }) => {
    if (!this.config) {
      throw new TypeError("Cannot read properties of null (reading 'addEvent')");
    }

    this.config.events.push(slide);
  });

  removeId = vi.fn();

  private handlers = new Map<string, Array<() => void>>();

  constructor(
    _elem: HTMLElement,
    private readonly deck: { events: Array<{ unique_id?: string }> },
  ) {
    FakeTimeline.instances.push(this);
  }

  on(event: string, callback: () => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
  }

  /** What TimelineJS does once its language file arrives and both panes are built. */
  finishLoading() {
    this.config = { events: [...this.deck.events] };
    this.ready = true;
    this.handlers.get('loaded')?.forEach((callback) => callback());
  }
}

function slide(id: string) {
  return { unique_id: id, start_date: { year: 2026, month: 1, day: 1 }, text: { headline: id } };
}

function deck(...ids: string[]): TimelineJsData {
  return { events: ids.map(slide) } as unknown as TimelineJsData;
}

function releaseStylesheet() {
  document.querySelector('link[data-timelinejs-css]')?.dispatchEvent(new Event('load'));
}

describe('TimelineJsHost', () => {
  beforeEach(() => {
    FakeTimeline.instances = [];
    (window as unknown as { TL: unknown }).TL = { Timeline: FakeTimeline };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { TL?: unknown }).TL;
    document.querySelector('link[data-timelinejs-css]')?.remove();
  });

  it('does not add slides until TimelineJS reports itself loaded', async () => {
    const { rerender } = render(<TimelineJsHost data={deck('a', 'b')} startAtSlide={0} sessionKey="s" />);

    releaseStylesheet();
    await waitFor(() => expect(FakeTimeline.instances).toHaveLength(1));
    const [instance] = FakeTimeline.instances;

    // Language still in flight: the host must neither claim readiness nor
    // reach into the unbuilt instance.
    expect(screen.getByText(/loading timeline/i)).toBeInTheDocument();
    expect(instance.add).not.toHaveBeenCalled();

    act(() => instance.finishLoading());

    await waitFor(() => expect(screen.queryByText(/loading timeline/i)).not.toBeInTheDocument());
    // The deck it was built from is already mounted — nothing to add.
    expect(instance.add).not.toHaveBeenCalled();

    // A grown buffer adds only the new slide, in place.
    rerender(<TimelineJsHost data={deck('a', 'b', 'c')} startAtSlide={0} sessionKey="s" />);

    await waitFor(() => expect(instance.add).toHaveBeenCalledTimes(1));
    expect(instance.add).toHaveBeenCalledWith(expect.objectContaining({ unique_id: 'c' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
