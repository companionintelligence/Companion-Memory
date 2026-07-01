import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatSidebar } from './ChatSidebar';
import type { Thread } from './types';

const thread = (id: string, name?: string, description?: string) =>
  ({ id, name, description }) as unknown as Thread;

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

  it('triggers new-thread and refresh actions', () => {
    const { onNewThread, onRefresh } = setup();

    fireEvent.click(screen.getByText('New Thread'));
    expect(onNewThread).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Refresh threads'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('deletes a thread without also selecting it', () => {
    const { onDeleteThread, onSelectThread } = setup();

    fireEvent.click(screen.getAllByTitle('Delete thread')[0]);

    expect(onDeleteThread).toHaveBeenCalledWith('t1');
    expect(onSelectThread).not.toHaveBeenCalled();
  });
});
