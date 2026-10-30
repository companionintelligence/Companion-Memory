import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { ChatSidebar } from './ChatSidebar';
import type { Thread } from './types';

const thread = (id: string, name?: string, description?: string, createdAt?: string) =>
  ({ id, name, description, createdAt }) as unknown as Thread;

function setup(overrides: Partial<Parameters<typeof ChatSidebar>[0]> = {}) {
  const props = {
    threads: [thread('t1', 'First chat'), thread('t2', 'Second chat')],
    selectedThreadId: null as string | null,
    onSelectThread: vi.fn(),
    onNewThread: vi.fn(),
    onDeleteThread: vi.fn(),
    loading: false,
    onRefresh: vi.fn(),
    ...overrides,
  };
  const view = render(<ChatSidebar {...props} />);

  return {
    ...props,
    rerender: (next: Partial<Parameters<typeof ChatSidebar>[0]>) =>
      view.rerender(<ChatSidebar {...props} {...next} />),
  };
}

describe('ChatSidebar', () => {
  it('shows the empty state when there are no threads', () => {
    setup({ threads: [] });
    expect(screen.getByText('No threads found')).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    setup({ threads: [], loading: true });
    // Placeholder rows, named for a screen reader, not a spinner.
    expect(screen.getByRole('status')).toHaveTextContent('Loading threads');
    expect(screen.queryByText('No threads found')).not.toBeInTheDocument();
  });

  it('lists thread names and selects one on click', () => {
    const { onSelectThread } = setup();

    expect(screen.getByText('First chat')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Second chat'));
    expect(onSelectThread).toHaveBeenCalledWith('t2');
  });

  it('falls back to a shortened id when a thread has no name', () => {
    setup({ threads: [thread('abcdef1234567890')] });
    expect(screen.getByText('Thread abcdef12')).toBeInTheDocument();
  });

  it('tells untitled threads apart by when they started', () => {
    setup({
      threads: [
        thread('01a0fd3b-aaaa', undefined, undefined, '2026-10-02T16:24:00Z'),
        thread('01a0fd3b-bbbb', undefined, undefined, '2026-10-02T17:31:00Z'),
      ],
    });

    const labels = screen.getAllByText(/^Chat · /).map((node) => node.textContent);

    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(screen.queryByText(/^Thread /)).not.toBeInTheDocument();
  });

  it('triggers new-thread and refresh actions', () => {
    const { onNewThread, onRefresh } = setup();

    fireEvent.click(screen.getByText('New Thread'));
    expect(onNewThread).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Refresh threads'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  // The trash is hover-revealed, and a touch screen never hovers — a tablet is in this (desktop) layout, so it
  // has to be visible without one.
  it('keeps the delete control visible on a touch screen', () => {
    setup();

    expect(screen.getAllByLabelText('Delete thread')[0].className).toContain('pointer-coarse:opacity-100');
  });

  it('deletes a thread without also selecting it', () => {
    const { onDeleteThread, onSelectThread } = setup();

    fireEvent.click(screen.getAllByLabelText('Delete thread')[0]);

    expect(onDeleteThread).toHaveBeenCalledWith('t1');
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  describe('collapsed rail', () => {
    function collapse() {
      fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    }

    it('shows each thread as its own tile, with no dot on an idle one', () => {
      setup({ threads: [thread('t1', 'Coffee with Jordan Lee'), thread('t2', 'Trip planning')] });
      collapse();

      expect(screen.getAllByTestId('thread-mark').map((tile) => tile.textContent)).toEqual(['CW', 'TP']);
      expect(screen.queryByTestId('thread-mark-busy')).not.toBeInTheDocument();
      expect(screen.queryByTestId('thread-mark-failed')).not.toBeInTheDocument();
    });

    it('marks the open thread as current and opens another on click', () => {
      const { onSelectThread } = setup({ selectedThreadId: 't1' });
      collapse();

      expect(screen.getByLabelText('First chat')).toHaveAttribute('aria-current', 'true');
      expect(screen.getByLabelText('Second chat')).not.toHaveAttribute('aria-current');

      fireEvent.click(screen.getByLabelText('Second chat'));
      expect(onSelectThread).toHaveBeenCalledWith('t2');
    });

    it('says in its name that a reply is being written', () => {
      setup({ threads: [{ ...thread('t1', 'First chat'), generationStatus: 'running' } as Thread] });
      collapse();

      expect(screen.getByLabelText('First chat, Replying…')).toBeInTheDocument();
      expect(screen.getByTestId('thread-mark-busy')).toBeInTheDocument();
    });

    it('starts a new thread from the rail', () => {
      const { onNewThread } = setup();
      collapse();

      fireEvent.click(screen.getByLabelText('New thread'));
      expect(onNewThread).toHaveBeenCalledTimes(1);
    });
  });

  it("says a thread's state in the open list too, and marks the open row", () => {
    setup({
      threads: [
        { ...thread('t1', 'First chat'), generationStatus: 'failed' } as Thread,
        thread('t2', 'Second chat'),
      ],
      selectedThreadId: 't2',
    });

    expect(screen.getByText('Last reply failed')).toHaveClass('sr-only');
    expect(screen.getByText('Second chat').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('First chat').closest('button')).not.toHaveAttribute('aria-current');
  });

  describe('keeping the open thread in view', () => {
    // The list is a 500px view from 0; a row is wherever `rows` puts it, else inside the view.
    let rows: Record<string, [top: number, bottom: number]>;
    let scrollTo: MockInstance;

    beforeEach(() => {
      rows = {};
      scrollTo = vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(() => {});
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const [top, bottom] = rows[this.getAttribute('data-thread-id') ?? ''] ?? [0, 500];

        return { top, bottom, left: 0, right: 80, width: 80, height: bottom - top } as DOMRect;
      });
    });

    afterEach(() => vi.restoreAllMocks());

    it('centres an open thread that is out of sight', () => {
      rows.t2 = [900, 940];
      setup({ selectedThreadId: 't2' });

      // 900 down, less half of the 500px view minus the 40px row.
      expect(scrollTo).toHaveBeenCalledWith({ top: 670 });
    });

    it('leaves a visible one alone', () => {
      setup({ selectedThreadId: 't1' });

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('nudges a row cut off at the bottom just far enough, rather than centring it under the pointer', () => {
      rows.t2 = [480, 520];
      setup({ selectedThreadId: 't2' });

      expect(scrollTo).toHaveBeenCalledWith({ top: 20 });
    });

    it('waits for the open thread to load, then leaves the list alone when another is deleted', () => {
      rows.t2 = [900, 940];
      const { rerender } = setup({ threads: [], selectedThreadId: 't2' });

      expect(scrollTo).not.toHaveBeenCalled();

      rerender({
        threads: [thread('t1', 'First chat'), thread('t2', 'Second chat'), thread('t3', 'Third chat')],
      });
      expect(scrollTo).toHaveBeenCalledWith({ top: 670 });

      // Scrolled away to delete an old thread: the list must not jump back.
      scrollTo.mockClear();
      rerender({ threads: [thread('t1', 'First chat'), thread('t2', 'Second chat')] });
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe('auto-collapse on resize', () => {
    function setInnerWidth(width: number) {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
    }

    // jsdom's default width (1024) is wider than the md breakpoint; restore it
    // so a later test file sharing this environment isn't left on a narrow one.
    afterEach(() => setInnerWidth(1024));

    it('starts collapsed on a narrow (mobile) viewport', () => {
      setInnerWidth(500);

      setup();

      // Collapsed hides the thread list and header controls — "New Thread" is
      // isExpanded-only content.
      expect(screen.queryByText('New Thread')).not.toBeInTheDocument();
    });

    it('expands again when the window is resized past the md breakpoint', () => {
      setInnerWidth(500);
      setup();

      expect(screen.queryByText('New Thread')).not.toBeInTheDocument();

      setInnerWidth(1024);
      fireEvent(window, new Event('resize'));

      expect(screen.getByText('New Thread')).toBeInTheDocument();
    });

    it('re-collapses on a resize back down below the breakpoint', () => {
      setInnerWidth(1024);
      setup();

      expect(screen.getByText('New Thread')).toBeInTheDocument();

      setInnerWidth(400);
      fireEvent(window, new Event('resize'));

      expect(screen.queryByText('New Thread')).not.toBeInTheDocument();
    });

    it('keeps a sidebar you collapsed when a resize stays above the breakpoint', () => {
      setInnerWidth(1024);
      setup();

      fireEvent.click(screen.getByLabelText('Collapse sidebar'));
      setInnerWidth(1200);
      fireEvent(window, new Event('resize'));

      expect(screen.queryByText('New Thread')).not.toBeInTheDocument();
    });
  });
});
