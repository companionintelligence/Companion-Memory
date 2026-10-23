import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  note: null as null | {
    id: string;
    title: string | null;
    content: string | null;
    created_at: string;
    updated_at: string;
  },
  execute: vi.fn(async () => undefined),
  navigate: vi.fn(),
  onUpdate: null as null | ((content: string) => void),
}));

vi.mock('@powersync/react', () => ({
  useQuery: () => ({ data: h.note ? [h.note] : [], isLoading: false, error: undefined }),
}));

vi.mock('@/api/powersync/session', () => ({
  getReplicaDatabase: () => ({ execute: h.execute }),
}));

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => <div data-testid="chat-menu" />,
}));

vi.mock('@ci/editor', () => {
  const Editor = ({
    children,
    onUpdate,
  }: {
    children: React.ReactNode;
    onUpdate: (content: string) => void;
  }) => {
    h.onUpdate = onUpdate;

    return <div data-testid="editor">{children}</div>;
  };

  Editor.Menu = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Editor.Content = () => <div data-testid="editor-content" />;

  return { Editor };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => h.navigate };
});

import { NotePage } from './NotePage';

describe('NotePage on a phone with a replica', () => {
  beforeEach(() => {
    h.execute.mockClear();
    h.navigate.mockClear();
  });

  it('shows the phone’s copy and writes an edit to the local table after the autosave delay', async () => {
    h.note = {
      id: 'n1',
      title: 'Groceries',
      content: '<p>eggs</p>',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
    };
    renderWithProviders(<NotePage />, { route: '/notes/n1', path: '/notes/:id' });

    expect(screen.getByTestId('editor')).toBeInTheDocument();
    expect(screen.getByTestId('chat-menu')).toBeInTheDocument();

    act(() => h.onUpdate?.('<p>eggs and milk</p>'));
    // Real timers: `waitFor` polls on a real clock, so the autosave delay is waited out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });

    await waitFor(() => expect(h.execute).toHaveBeenCalled());

    const [sql, params] = h.execute.mock.calls[0] as unknown as [string, unknown[]];

    expect(sql).toMatch(/^UPDATE notes SET title = \?, content = \?, updated_at = \? WHERE id = \?/);
    expect(params[0]).toBe('eggs and milk');
    expect(params[1]).toBe('<p>eggs and milk</p>');
    expect(params[3]).toBe('n1');
  });

  it('a new note is created locally under a minted id and the route moves to it, once', async () => {
    h.note = null;
    renderWithProviders(<NotePage />, { route: '/notes/new', path: '/notes/:id' });

    act(() => h.onUpdate?.('<p>Call the dentist</p>'));
    // Real timers: `waitFor` polls on a real clock, so the autosave delay is waited out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });

    await waitFor(() => expect(h.execute).toHaveBeenCalled());

    const [sql, params] = h.execute.mock.calls[0] as unknown as [string, unknown[]];

    expect(sql).toMatch(/^INSERT INTO notes/);
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params[1]).toBe('Call the dentist');
    expect(h.navigate).toHaveBeenCalledWith(`/notes/${params[0]}`, { replace: true });
  });
});
