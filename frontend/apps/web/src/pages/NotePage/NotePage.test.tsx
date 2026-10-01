import { type ReactNode } from 'react';

import { GlobalUID } from '@ci/common';
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { NotePage } from './NotePage';

/**
 * The offline-capture path: what happens when a save reaches the appliance and fails.
 * `Editor` (a real rich-text editor from `@ci/editor`) is stood in for — that package
 * owns its own correctness — so these tests can drive `onUpdate` directly and focus on
 * what this page does with the result: fall back to the durable local queue rather than
 * losing the edit, tell the user it queued, or refuse outright when queueing would be
 * unsafe (overwriting a note this page never actually held).
 */

const AUTOSAVE_THROTTLE_MS = 1000;

const editorState = vi.hoisted(() => ({
  onUpdate: undefined as ((content: string) => void) | undefined,
}));

// Same reason as ReceiptPage/PlaceSheet/ContentSheet: `ChatWithAgentMenu`
// reaches for the agent-harness hook context this page's providers do not
// supply, so it threw during render and took the page down before the offline
// path under test could run.
vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: ({ size }: { size?: string }) => <span data-testid="chat-menu" data-size={size} />,
}));

vi.mock('@ci/editor', () => {
  function MockEditor({
    children,
    onUpdate,
  }: {
    content?: string;
    onUpdate?: (content: string) => void;
    children?: ReactNode;
  }) {
    editorState.onUpdate = onUpdate;

    return <>{children}</>;
  }

  MockEditor.Menu = ({ children }: { children?: ReactNode }) => <>{children}</>;
  MockEditor.Content = () => null;

  return { Editor: MockEditor };
});

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

// The phone/desktop switch. Wide by default, so every other test sees the layout
// it always has.
const device = vi.hoisted(() => ({ layout: { isMobile: false } }));

const common = vi.hoisted(() => ({
  captureNote: vi.fn(),
  forgetQueuedNote: vi.fn(),
  isQueuedNote: vi.fn(() => false),
  newNoteId: vi.fn(() => 'minted-note-id'),
}));

// Only the outbox/native-capture surface is faked; GlobalUID, buildNoteRecord,
// usePageTitle and LoadingPage stay real — this is a page-logic test, not a re-test of
// those small pure helpers.
vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  captureNote: common.captureNote,
  forgetQueuedNote: common.forgetQueuedNote,
  isQueuedNote: common.isQueuedNote,
  newNoteId: common.newNoteId,
  useOutboxQueue: () => ({ pending: 0 }),
  useDeviceLayout: () => device.layout,
}));

const GET_NOTE = gql(`
  query GetNote($id: ID!) {
    note(id: $id) {
      id
      title
      content
      updatedAt
    }
  }
`);

const CREATE_NOTE = gql(`
  mutation CreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      success
      note {
        id
        title
        content
        updatedAt
      }
    }
  }
`);

const UPDATE_NOTE = gql(`
  mutation UpdateNote($input: UpdateNoteInput!) {
    updateNote(input: $input) {
      success
      note {
        id
        title
        content
        updatedAt
      }
    }
  }
`);

function type(content: string) {
  act(() => editorState.onUpdate?.(content));
}

// Real timers rather than fake ones: `waitFor` below polls on a real clock, and this
// autosave debounce is a genuine 1s wait a user experiences, not one worth faking away.
async function flushAutosave() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_THROTTLE_MS + 50));
  });
}

beforeEach(() => {
  device.layout = { isMobile: false };
  editorState.onUpdate = undefined;
  navigate.mockReset();
  common.captureNote.mockReset();
  common.forgetQueuedNote.mockReset();
  common.isQueuedNote.mockReset();
  common.isQueuedNote.mockReturnValue(false);
  common.newNoteId.mockReset();
  common.newNoteId.mockReturnValue('minted-note-id');
});

describe('NotePage — offline capture', () => {
  it('queues a brand-new note to the durable outbox and hands off to its minted id when the appliance is unreachable', async () => {
    common.captureNote.mockResolvedValue({
      status: 'queued',
      record: {
        id: 'minted-note-id',
        title: 'Grocery list',
        content: '<p>Grocery list</p>',
        captured_at: '2026-08-18T00:00:00.000Z',
      },
      id: 'row-1',
    });

    renderWithProviders(<NotePage />, {
      route: '/notes/new',
      path: '/notes/:id',
      mocks: [
        {
          request: {
            query: CREATE_NOTE,
            variables: { input: { content: '<p>Grocery list</p>', title: 'Grocery list' } },
          },
          error: new Error('appliance unreachable'),
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type('<p>Grocery list</p>');
    await flushAutosave();

    // The mutation was genuinely attempted first — this is a fallback, not a
    // web-only shortcut that skips the network.
    await waitFor(() => expect(common.captureNote).toHaveBeenCalledTimes(1));
    expect(common.captureNote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'minted-note-id',
        title: 'Grocery list',
        content: '<p>Grocery list</p>',
      }),
    );

    // The minted id is the note's real, final id — the page hands off to it rather
    // than staying on `/notes/new`, which would try to create a second note on retry.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/notes/minted-note-id', { replace: true }));

    // Queued reads as a SAVED state, not a warning: it is durably on disk.
    expect(await screen.findByText('Saved offline')).toBeInTheDocument();
    expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument();
  });

  it('falls back to the offline queue when saving an existing note fails, and shows it as saved offline', async () => {
    const noteGlobalId = GlobalUID.encode('note', 'abc-uuid');

    common.captureNote.mockResolvedValue({
      status: 'queued',
      record: {
        id: 'abc-uuid',
        title: 'Meeting notes',
        content: '<p>Meeting notes</p>',
        captured_at: '2026-08-18T00:00:00.000Z',
      },
      id: 'row-2',
    });

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [
        {
          request: { query: GET_NOTE, variables: { id: noteGlobalId } },
          result: {
            data: {
              note: {
                __typename: 'NoteType',
                id: noteGlobalId,
                title: 'Old title',
                content: '<p>Old content</p>',
                updatedAt: '2026-08-01T00:00:00.000Z',
              },
            },
          },
        },
        {
          request: {
            query: UPDATE_NOTE,
            variables: {
              input: { id: noteGlobalId, content: '<p>Meeting notes</p>', title: 'Meeting notes' },
            },
          },
          error: new Error('appliance unreachable'),
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type('<p>Meeting notes</p>');
    await flushAutosave();

    await waitFor(() => expect(common.captureNote).toHaveBeenCalledTimes(1));
    expect(common.captureNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'abc-uuid', title: 'Meeting notes', content: '<p>Meeting notes</p>' }),
    );

    expect(await screen.findByText('Saved offline')).toBeInTheDocument();
    // No navigation for an existing note — it already has its permanent URL.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('refuses to queue an edit for a note that never loaded, rather than overwriting real content with an empty snapshot', async () => {
    const noteGlobalId = GlobalUID.encode('note', 'missing-uuid');
    common.isQueuedNote.mockReturnValue(false);

    renderWithProviders(<NotePage />, {
      route: '/notes/missing-uuid',
      path: '/notes/:id',
      mocks: [
        {
          request: { query: GET_NOTE, variables: { id: noteGlobalId } },
          error: new Error('note not found'),
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type('<p>Some stray text</p>');
    await flushAutosave();

    // The one thing this path must never do: queue a snapshot built from content this
    // page never actually received from the appliance.
    expect(common.captureNote).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Not saved — this note could not be loaded, so changes cannot be queued.'),
    ).toBeInTheDocument();
  });

  it('tells the user a queued note cannot be edited yet, rather than the generic could-not-load message', async () => {
    const noteGlobalId = GlobalUID.encode('note', 'queued-uuid');
    // This client authored the note offline in an earlier session (remembered via
    // localStorage) but it has not synced, so the appliance still has nothing to serve.
    common.isQueuedNote.mockReturnValue(true);

    renderWithProviders(<NotePage />, {
      route: '/notes/queued-uuid',
      path: '/notes/:id',
      mocks: [
        {
          request: { query: GET_NOTE, variables: { id: noteGlobalId } },
          error: new Error('note not found'),
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type('<p>More edits</p>');
    await flushAutosave();

    expect(common.captureNote).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Queued — this note is waiting to sync and cannot be edited until it does.'),
    ).toBeInTheDocument();
  });
});

describe('NotePage — toolbar on a phone', () => {
  const noteGlobalId = GlobalUID.encode('note', 'abc-uuid');
  const savedNote = {
    request: { query: GET_NOTE, variables: { id: noteGlobalId } },
    result: {
      data: {
        note: {
          __typename: 'NoteType',
          id: noteGlobalId,
          title: 'Old title',
          content: '<p>Old content</p>',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      },
    },
  };

  it('uses the one-icon chat menu on a phone, where the labelled buttons do not fit', async () => {
    device.layout = { isMobile: true };
    renderWithProviders(<NotePage />, { route: '/notes/abc-uuid', path: '/notes/:id', mocks: [savedNote] });

    expect(await screen.findByTestId('chat-menu')).toHaveAttribute('data-size', 'icon');
  });

  it('keeps the labelled chat buttons on a wide screen', async () => {
    renderWithProviders(<NotePage />, { route: '/notes/abc-uuid', path: '/notes/:id', mocks: [savedNote] });

    expect(await screen.findByTestId('chat-menu')).toHaveAttribute('data-size', 'sm');
  });

  it('shows the saved time only to screen readers on a phone, and visibly from the desktop breakpoint up', async () => {
    const { container } = renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [savedNote],
    });

    await screen.findByTestId('chat-menu');
    const words = container.querySelector('time')?.parentElement;

    expect(words).toHaveClass('sr-only', 'device:not-sr-only');
  });
});
