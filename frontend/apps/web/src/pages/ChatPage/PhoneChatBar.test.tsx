import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PhoneChatBar } from './PhoneChatBar';
import type { Thread } from './types';

const thread = (id: string, name: string | null, createdAt?: string) =>
  ({ id, name, description: null, createdAt }) as unknown as Thread;

function setup(overrides: Partial<Parameters<typeof PhoneChatBar>[0]> = {}) {
  const props = {
    threads: [thread('t1', 'Dinner plans'), thread('t2', 'Trip to Lisbon')],
    loading: false,
    selectedThreadId: null as string | null,
    onSelectThread: vi.fn(),
    onNewThread: vi.fn(),
    onDeleteThread: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };

  render(<PhoneChatBar {...props} />);

  return props;
}

const openList = () => fireEvent.click(screen.getByRole('button', { name: 'Chats' }));

/**
 * The phone has no `ChatSidebar` (it portals into a slot the phone layout never renders), so this bar is the only
 * place in the chat itself to start a new chat, reopen a past one, or delete one.
 */
describe('PhoneChatBar', () => {
  it('starts a new chat from one tap', () => {
    const { onNewThread } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    expect(onNewThread).toHaveBeenCalledTimes(1);
  });

  it('keeps the list closed until it is asked for', () => {
    setup();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Dinner plans')).not.toBeInTheDocument();
  });

  it('lists past chats by title, and refreshes the list as it opens', () => {
    const { onRefresh } = setup();

    openList();

    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Dinner plans' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Trip to Lisbon' })).toBeInTheDocument();
    // A title lands after the first reply; the list in hand was fetched before that.
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('opens the chat that was picked, and puts the list away', () => {
    const { onSelectThread } = setup();

    openList();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Trip to Lisbon' }));

    expect(onSelectThread).toHaveBeenCalledWith('t2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('marks the chat that is open', () => {
    setup({ selectedThreadId: 't2' });

    openList();

    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Trip to Lisbon' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: 'Dinner plans' })).not.toHaveAttribute('aria-current');
  });

  it('tells untitled chats apart by when they started rather than by an id nobody can read', () => {
    setup({
      threads: [
        thread('01a0fd3b-aaaa', null, '2026-10-02T16:24:00Z'),
        thread('01a0fd3b-bbbb', null, '2026-10-02T17:31:00Z'),
      ],
    });

    openList();

    const rows = within(screen.getByRole('dialog')).getAllByRole('button', { name: /^Chat · / });

    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).not.toBe(rows[1].textContent);
    expect(screen.queryByText(/^Thread /)).not.toBeInTheDocument();
  });

  it('says so when there are no chats yet, or while they load', () => {
    const { unmount } = render(
      <PhoneChatBar
        threads={[]}
        loading={false}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onNewThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    openList();
    expect(screen.getByText('No chats yet.')).toBeInTheDocument();
    unmount();

    render(
      <PhoneChatBar
        threads={[]}
        loading
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onNewThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    openList();
    // Placeholder rows, named for a screen reader, in place of a line of text.
    expect(screen.getByRole('status')).toHaveTextContent('Loading chats');
    expect(screen.queryByText('No chats yet.')).not.toBeInTheDocument();
  });

  describe('deleting a chat', () => {
    it('asks first, naming the chat, and deletes nothing until it is confirmed', () => {
      const { onDeleteThread } = setup();

      openList();
      fireEvent.click(screen.getByRole('button', { name: 'Delete Dinner plans' }));

      const confirm = screen.getByRole('alertdialog');

      expect(within(confirm).getByText(/Dinner plans/)).toBeInTheDocument();
      expect(onDeleteThread).not.toHaveBeenCalled();

      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

      expect(onDeleteThread).toHaveBeenCalledTimes(1);
      expect(onDeleteThread).toHaveBeenCalledWith('t1');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('leaves the chat alone when the person backs out', () => {
      const { onDeleteThread } = setup();

      openList();
      fireEvent.click(screen.getByRole('button', { name: 'Delete Trip to Lisbon' }));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));

      expect(onDeleteThread).not.toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('does not open the chat it is deleting', () => {
      const { onSelectThread } = setup();

      openList();
      fireEvent.click(screen.getByRole('button', { name: 'Delete Dinner plans' }));

      expect(onSelectThread).not.toHaveBeenCalled();
    });
  });
});
