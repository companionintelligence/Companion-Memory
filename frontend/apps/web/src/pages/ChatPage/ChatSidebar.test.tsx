import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  render(<ChatSidebar {...props} />);

  return props;
}

describe('ChatSidebar', () => {
  it('shows the empty state when there are no threads', () => {
    setup({ threads: [] });
    expect(screen.getByText('No threads found')).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    setup({ threads: [], loading: true });
    expect(screen.getByText('Loading threads...')).toBeInTheDocument();
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
  });
});
