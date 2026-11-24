import { type ReactNode } from 'react';

import { GlobalUID } from '@ci/common';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Link, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { NotePage } from './NotePage';

/**
 * Edits Memory does not have yet: what is typed while a new note's first save is still out,
 * and leaving the page before a change is saved. Unlike `NotePage.test.tsx` the router is
 * real here, so the page really moves from `/notes/new` to its id and a link really leaves.
 */

const AUTOSAVE_THROTTLE_MS = 1000;

const editorState = vi.hoisted(() => ({
  onUpdate: undefined as ((content: string) => void) | undefined,
  /** Every document an editor was opened with, in order. */
  opened: [] as Array<string | undefined>,
}));

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => <span data-testid="chat-menu" />,
}));

vi.mock('@ci/editor', () => {
  function MockEditor({
    children,
    content,
    onUpdate,
  }: {
    content?: string;
    onUpdate?: (content: string) => void;
    children?: ReactNode;
  }) {
    editorState.onUpdate = onUpdate;
    editorState.opened.push(content);

    return <>{children}</>;
  }

  MockEditor.Menu = ({ children }: { children?: ReactNode }) => <>{children}</>;
  MockEditor.Content = () => null;

  return { Editor: MockEditor };
});

const common = vi.hoisted(() => ({ captureNote: vi.fn() }));

vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  captureNote: common.captureNote,
  forgetQueuedNote: vi.fn(),
  isQueuedNote: vi.fn(() => false),
  newNoteId: vi.fn(() => 'minted-note-id'),
  useOutboxQueue: () => ({ pending: 0 }),
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

const mintedGlobalId = GlobalUID.encode('note', 'minted-note-id');
const noteGlobalId = GlobalUID.encode('note', 'abc-uuid');

function noteResult(id: string, content: string, updatedAt: string) {
  return {
    __typename: 'NoteType',
    id,
    title: content.replace(/<[^>]+>/g, ''),
    content,
    updatedAt,
  };
}

const loadedNote = {
  request: { query: GET_NOTE, variables: { id: noteGlobalId } },
  result: { data: { note: noteResult(noteGlobalId, '<p>Trip ideas</p>', '2026-08-01T00:00:00.000Z') } },
};

function updated(content: string, extra: Record<string, unknown> = {}) {
  return {
    query: UPDATE_NOTE,
    variables: { input: { id: noteGlobalId, content, title: content.replace(/<[^>]+>/g, ''), ...extra } },
  };
}

/** The note page with one link out of it, the way the app's navigation leaves a note. */
function App() {
  return (
    <Routes>
      <Route
        path="/notes/:id"
        element={
          <>
            <NotePage />
            <Link to="/elsewhere">Elsewhere</Link>
            <Link to="/notes/other-uuid">Another note</Link>
          </>
        }
      />
      <Route path="/elsewhere" element={<p>Somewhere else</p>} />
    </Routes>
  );
}

function type(content: string) {
  act(() => editorState.onUpdate?.(content));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function unloadIsStopped() {
  const event = new Event('beforeunload', { cancelable: true });

  window.dispatchEvent(event);

  return event.defaultPrevented;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  editorState.onUpdate = undefined;
  editorState.opened = [];
  common.captureNote.mockReset();
  // A browser: nothing to queue to.
  common.captureNote.mockImplementation(async (record: unknown) => ({
    status: 'unavailable',
    record,
    message: 'no offline queue here',
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NotePage — a new note whose first save is slow', () => {
  it('saves what was typed while the first save was out, and does not show it saved before then', async () => {
    const first = '<p>Packing list</p>';
    const all = '<p>Packing list with sunscreen and a hat</p>';
    const followUp = vi.fn(() => ({
      data: {
        updateNote: {
          __typename: 'UpdateNotePayload',
          success: true,
          note: noteResult(mintedGlobalId, all, '2026-08-18T00:00:09.000Z'),
        },
      },
    }));

    renderWithProviders(<App />, {
      route: '/notes/new',
      mocks: [
        {
          request: {
            query: CREATE_NOTE,
            variables: { input: { id: mintedGlobalId, content: first, title: 'Packing list' } },
          },
          // Memory frozen for 5 s, then it answers.
          delay: 5000,
          result: {
            data: {
              createNote: {
                __typename: 'CreateNotePayload',
                success: true,
                note: noteResult(mintedGlobalId, first, '2026-08-18T00:00:05.000Z'),
              },
            },
          },
        },
        {
          request: {
            query: UPDATE_NOTE,
            variables: {
              input: { id: mintedGlobalId, content: all, title: 'Packing list with sunscreen and a hat' },
            },
          },
          delay: 3000,
          result: followUp,
        },
        {
          request: { query: GET_NOTE, variables: { id: mintedGlobalId } },
          result: { data: { note: noteResult(mintedGlobalId, first, '2026-08-18T00:00:05.000Z') } },
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type(first);
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    // More typed while the create is out.
    type(all);
    await advance(AUTOSAVE_THROTTLE_MS + 50);

    // The create lands and the page moves to the note's id. The rest is not saved yet.
    await advance(5000);
    await screen.findByTestId('chat-menu');
    expect(await screen.findByText('Saving')).toBeInTheDocument();
    expect(document.querySelector('.lucide-check')).not.toBeInTheDocument();

    await advance(3000);

    await waitFor(() => expect(followUp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('.lucide-check')).toBeInTheDocument());
  });

  it('still creates a new note left before its first save went out', async () => {
    const created = vi.fn(() => ({
      data: {
        createNote: {
          __typename: 'CreateNotePayload',
          success: true,
          note: noteResult(mintedGlobalId, '<p>Call the vet</p>', '2026-08-18T00:00:01.000Z'),
        },
      },
    }));

    renderWithProviders(<App />, {
      route: '/notes/new',
      mocks: [
        {
          request: {
            query: CREATE_NOTE,
            variables: {
              input: { id: mintedGlobalId, content: '<p>Call the vet</p>', title: 'Call the vet' },
            },
          },
          result: created,
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type('<p>Call the vet</p>');
    fireEvent.click(screen.getByText('Elsewhere'));

    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
  });
});

describe('NotePage — leaving with changes Memory does not have', () => {
  it('asks before the tab is closed or reloaded while a change is not saved, and not once it is', async () => {
    renderWithProviders(<App />, {
      route: '/notes/abc-uuid',
      mocks: [
        loadedNote,
        {
          request: updated('<p>Trip ideas in May</p>'),
          result: { data: { updateNote: { __typename: 'UpdateNotePayload', success: true, note: null } } },
        },
      ],
    });

    await screen.findByTestId('chat-menu');
    expect(unloadIsStopped()).toBe(false);

    type('<p>Trip ideas in May</p>');
    expect(unloadIsStopped()).toBe(true);

    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await waitFor(() => expect(unloadIsStopped()).toBe(false));
  });

  it('asks before a link inside the app leaves a note whose save failed: Stay keeps it, Leave goes', async () => {
    renderWithProviders(<App />, {
      route: '/notes/abc-uuid',
      mocks: [
        loadedNote,
        { request: updated('<p>Trip ideas in May</p>'), error: new Error('502 Bad Gateway') },
        // Leaving still tries once more on the way out.
        {
          request: updated('<p>Trip ideas in May</p>', { expectedUpdatedAt: '2026-08-01T00:00:00.000Z' }),
          error: new Error('502 Bad Gateway'),
        },
      ],
    });

    await screen.findByTestId('chat-menu');
    type('<p>Trip ideas in May</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await screen.findByText('Not saved yet.');

    fireEvent.click(screen.getByText('Elsewhere'));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Leave without saving?');
    expect(screen.getByTestId('chat-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('chat-menu')).toBeInTheDocument();
    expect(screen.queryByText('Somewhere else')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Elsewhere'));
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));

    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
  });

  it('does not ask when the only unsaved edit is the one about to be sent, and sends it on the way out', async () => {
    const landed = vi.fn(() => ({
      data: { updateNote: { __typename: 'UpdateNotePayload', success: true, note: null } },
    }));

    renderWithProviders(<App />, {
      route: '/notes/abc-uuid',
      mocks: [loadedNote, { request: updated('<p>Trip ideas in May</p>'), result: landed }],
    });

    await screen.findByTestId('chat-menu');
    type('<p>Trip ideas in May</p>');
    fireEvent.click(screen.getByText('Elsewhere'));

    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(landed).toHaveBeenCalledTimes(1));
  });
});

describe('NotePage — leaving while a save is still out', () => {
  it('asks, and goes by itself once the save lands', async () => {
    const landed = vi.fn(() => ({
      data: { updateNote: { __typename: 'UpdateNotePayload', success: true, note: null } },
    }));

    renderWithProviders(<App />, {
      route: '/notes/abc-uuid',
      mocks: [loadedNote, { request: updated('<p>Trip ideas in May</p>'), delay: 3000, result: landed }],
    });

    await screen.findByTestId('chat-menu');
    type('<p>Trip ideas in May</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    expect(screen.getByText('Saving')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Elsewhere'));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Leave without saving?');

    await advance(3000);

    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it('keeps asking when that save fails instead', async () => {
    renderWithProviders(<App />, {
      route: '/notes/abc-uuid',
      mocks: [
        loadedNote,
        { request: updated('<p>Trip ideas in May</p>'), delay: 3000, error: new Error('502 Bad Gateway') },
      ],
    });

    await screen.findByTestId('chat-menu');
    type('<p>Trip ideas in May</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);

    fireEvent.click(screen.getByText('Elsewhere'));
    await screen.findByRole('alertdialog');

    await advance(3000);

    expect(await screen.findByText('Not saved yet.')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText('Somewhere else')).not.toBeInTheDocument();
  });
});

describe('NotePage — moving to another note after saving offline', () => {
  it('does not open the next note with the text queued for the one before', async () => {
    const typed = '<p>Trip ideas in May</p>';
    const otherGlobalId = GlobalUID.encode('note', 'other-uuid');

    // A device with an offline queue: the failed save is queued, so the page holds it.
    common.captureNote.mockImplementation(async (record: { captured_at: string }) => ({
      status: 'queued',
      record,
      id: 'row-1',
    }));

    renderWithProviders(<App />, {
      route: '/notes/abc-uuid',
      mocks: [
        loadedNote,
        { request: updated(typed), error: new Error('502 Bad Gateway') },
        // The next note is still loading when the page gets there.
        { request: { query: GET_NOTE, variables: { id: otherGlobalId } }, delay: Infinity, result: {} },
      ],
    });

    await screen.findByTestId('chat-menu');
    type(typed);
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    expect(await screen.findByText('Saved offline')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Another note'));
    await advance(100);

    expect(editorState.opened).not.toContain(typed);
    expect(screen.queryByText('Saved offline')).not.toBeInTheDocument();
  });
});
