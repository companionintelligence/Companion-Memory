import { type ReactNode } from 'react';

import { type MockedResponse } from '@apollo/client/testing';
import { GlobalUID } from '@ci/common';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  requestConnectionRefresh: vi.fn(),
  // What the connection check says; null is no provider, as in most of these tests.
  connection: null as { mode: string } | null,
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
  requestConnectionRefresh: common.requestConnectionRefresh,
  useOptionalConnectionMode: () => common.connection,
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
  common.requestConnectionRefresh.mockReset();
  common.connection = null;
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
            variables: {
              input: {
                id: GlobalUID.encode('note', 'minted-note-id'),
                content: '<p>Grocery list</p>',
                title: 'Grocery list',
              },
            },
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

  it('stops saying "Saved offline" once a later save reaches the appliance', async () => {
    const noteGlobalId = GlobalUID.encode('note', 'abc-uuid');

    common.captureNote.mockImplementation(async (record: { captured_at: string }) => ({
      status: 'queued',
      record,
      id: 'row-4',
    }));

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
        {
          request: {
            query: UPDATE_NOTE,
            variables: {
              input: { id: noteGlobalId, content: '<p>Meeting notes v2</p>', title: 'Meeting notes v2' },
            },
          },
          result: { data: { updateNote: { success: true, note: null } } },
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type('<p>Meeting notes</p>');
    await flushAutosave();

    expect(await screen.findByText('Saved offline')).toBeInTheDocument();

    type('<p>Meeting notes v2</p>');
    await flushAutosave();

    await waitFor(() => expect(screen.queryByText('Saved offline')).not.toBeInTheDocument());
    expect(common.captureNote).toHaveBeenCalledTimes(1);
  });
});

describe('NotePage — a save that hangs', () => {
  const SLOW_SAVE_MS = 8000;
  const noteGlobalId = GlobalUID.encode('note', 'abc-uuid');

  const loadedNote = {
    request: { query: GET_NOTE, variables: { id: noteGlobalId } },
    result: {
      data: {
        note: {
          __typename: 'NoteType',
          id: noteGlobalId,
          title: 'Trip ideas',
          content: '<p>Trip ideas</p>',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      },
    },
  };

  // One paragraph per note here, so its text is also the title the page derives.
  function savedAfter(content: string, delay: number) {
    return {
      request: {
        query: UPDATE_NOTE,
        variables: { input: { id: noteGlobalId, content, title: content.replace(/<[^>]+>/g, '') } },
      },
      delay,
      result: { data: { updateNote: { success: true, note: null } } },
    };
  }

  // Fake clock that still moves on its own, so `findBy*` and the mocked query keep
  // working, while the long waits below are jumped instead of sat through.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('stops saying "Saving" once a save has gone unanswered for a while', async () => {
    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      // Behind the gateway, a stopped Memory leaves the request open for 30 s or more.
      mocks: [loadedNote, savedAfter('<p>Trip ideas in May</p>', Infinity)],
    });

    await screen.findByTestId('chat-menu');
    type('<p>Trip ideas in May</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);

    expect(await screen.findByText('Saving')).toBeInTheDocument();
    expect(screen.queryByText(/not saved yet/i)).not.toBeInTheDocument();

    await advance(SLOW_SAVE_MS);

    expect(screen.getByText('Not saved yet.')).toHaveTextContent(
      "Not saved yet. Your Companion isn't answering.",
    );
    expect(screen.queryByText('Saving')).not.toBeInTheDocument();
    // Nothing failed yet, so nothing is queued; the text is still in the editor.
    expect(common.captureNote).not.toHaveBeenCalled();
  });

  it('drops the warning once the save is finally answered', async () => {
    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [loadedNote, savedAfter('<p>Trip ideas in May</p>', SLOW_SAVE_MS + 2000)],
    });

    await screen.findByTestId('chat-menu');
    type('<p>Trip ideas in May</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await advance(SLOW_SAVE_MS);

    expect(screen.getByText('Not saved yet.')).toBeInTheDocument();

    await advance(2000);

    expect(screen.queryByText(/not saved yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Saving')).not.toBeInTheDocument();
  });

  it('does not call a slow but answering Companion stuck when saves overlap', async () => {
    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [
        loadedNote,
        savedAfter('<p>Trip ideas in May</p>', 7000),
        savedAfter('<p>Trip ideas in June</p>', Infinity),
      ],
    });

    await screen.findByTestId('chat-menu');

    // The first save goes out at about 1 s and is answered at about 8 s. The second
    // goes out at about 7 s, while the first is still open, so Apollo's `loading`
    // never drops in between.
    type('<p>Trip ideas in May</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await advance(5000);
    type('<p>Trip ideas in June</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);

    // 8.5 s after the first save went out: it was answered, so this is not stuck.
    await advance(2400);

    expect(screen.getByText('Saving')).toBeInTheDocument();
    expect(screen.queryByText(/not saved yet/i)).not.toBeInTheDocument();

    // 8 s after that answer with nothing else back, it is.
    await advance(SLOW_SAVE_MS);

    expect(screen.getByText('Not saved yet.')).toBeInTheDocument();
  });

  it('queues a save that fails late with the time it was sent, so it cannot outrank a newer save', async () => {
    // Date too, so the 30 s jump below shows up in the timestamp the page writes. A
    // second `useFakeTimers` while the clock is already fake is a no-op, so drop it first.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
    common.captureNote.mockImplementation(async (record: { captured_at: string }) => ({
      status: 'queued',
      record,
      id: 'row-3',
    }));

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [
        loadedNote,
        {
          ...savedAfter('<p>Trip ideas in May</p>', 30_000),
          result: undefined,
          error: new Error('502 Bad Gateway'),
        },
      ],
    });

    await screen.findByTestId('chat-menu');
    const typedAt = Date.now();

    type('<p>Trip ideas in May</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await advance(30_000);

    await waitFor(() => expect(common.captureNote).toHaveBeenCalledTimes(1));
    const record = common.captureNote.mock.calls[0][0] as { captured_at: string };

    // Sent about 1 s after typing and refused 30 s later. Stamped with the refusal, the
    // snapshot would look newer than a save that landed in between, and its drain would
    // put this older text back over that one.
    expect(Date.parse(record.captured_at) - typedAt).toBeLessThan(5000);
    expect(await screen.findByText('Saved offline')).toBeInTheDocument();
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

describe('NotePage — a failed save is sent again on its own', () => {
  const noteGlobalId = GlobalUID.encode('note', 'abc-uuid');
  const loadedAt = '2026-08-01T00:00:00.000Z';
  const savedAt = '2026-08-01T00:05:00.000Z';
  const typed = '<p>Trip ideas in May</p>';
  const input = { id: noteGlobalId, content: typed, title: 'Trip ideas in May' };

  const loadedNote = {
    request: { query: GET_NOTE, variables: { id: noteGlobalId } },
    result: {
      data: {
        note: {
          __typename: 'NoteType',
          id: noteGlobalId,
          title: 'Trip ideas',
          content: '<p>Trip ideas</p>',
          updatedAt: loadedAt,
        },
      },
    },
  };

  // What the Hub's gateway answers while Memory is stopped.
  const gatewayError = () => new Error('502 Bad Gateway');

  const typedSaveFails = {
    request: { query: UPDATE_NOTE, variables: { input } },
    error: gatewayError(),
  };

  // A retry holds an edit typed before the failure, so it says which version it may replace.
  function retried(expectedUpdatedAt: string, outcome: Pick<MockedResponse, 'error' | 'result' | 'delay'>) {
    return {
      request: { query: UPDATE_NOTE, variables: { input: { ...input, expectedUpdatedAt } } },
      ...outcome,
    };
  }

  function answer(success: boolean, content: string, updatedAt: string) {
    return vi.fn(() => ({
      data: {
        updateNote: {
          __typename: 'UpdateNotePayload',
          success,
          note: { __typename: 'NoteType', id: noteGlobalId, title: 'Trip ideas', content, updatedAt },
        },
      },
    }));
  }

  // Last in the list: any UpdateNote nobody expected lands here.
  function unexpected() {
    const sent = vi.fn(() => true);

    return {
      sent,
      mock: {
        request: { query: UPDATE_NOTE },
        variableMatcher: sent,
        maxUsageCount: 99,
        result: { data: { updateNote: { __typename: 'UpdateNotePayload', success: true, note: null } } },
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    // A browser: no offline queue to fall back on.
    common.captureNote.mockImplementation(async (record: unknown) => ({
      status: 'unavailable',
      record,
      message: 'no offline queue here',
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function typeAndFail(text = typed) {
    await screen.findByTestId('chat-menu');
    type(text);
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await waitFor(() => expect(common.captureNote).toHaveBeenCalled());
  }

  it('sends it again after 2 s, then 4 s, with nothing typed, and shows it saved once it lands', async () => {
    const landed = answer(true, typed, savedAt);

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [
        loadedNote,
        typedSaveFails,
        retried(loadedAt, { error: gatewayError() }),
        retried(loadedAt, { result: landed }),
      ],
    });

    await typeAndFail();

    // Not the old "Not saved — your Companion is unreachable": it is being taken care of.
    expect(await screen.findByText('Not saved yet.')).toHaveTextContent(
      "Not saved yet. Your Companion isn't answering.",
    );
    expect(common.requestConnectionRefresh).toHaveBeenCalled();

    await advance(2000);
    // The first retry failed too, so the next wait is twice as long.
    await advance(2000);
    expect(landed).not.toHaveBeenCalled();

    await advance(2000);
    await waitFor(() => expect(landed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument());
    expect(document.querySelector('time')).toBeInTheDocument();
  });

  it.each([
    ['the browser is back online', () => window.dispatchEvent(new Event('online'))],
    ['the window gets focus again', () => window.dispatchEvent(new Event('focus'))],
    ['the tab is shown again', () => document.dispatchEvent(new Event('visibilitychange'))],
  ])('sends it again at once when %s', async (_when, fire) => {
    const landed = answer(true, typed, savedAt);

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [loadedNote, typedSaveFails, retried(loadedAt, { result: landed })],
    });

    await typeAndFail();
    await screen.findByText('Not saved yet.');

    act(fire);

    await waitFor(() => expect(landed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument());
  });

  it('sends it again at once when the connection check finds Memory again', async () => {
    const landed = answer(true, typed, savedAt);

    common.connection = { mode: 'fresh' };

    const view = renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [loadedNote, typedSaveFails, retried(loadedAt, { result: landed })],
    });

    await typeAndFail();
    await screen.findByText('Not saved yet.');

    common.connection = { mode: 'connected' };
    view.rerender(<NotePage />);

    await waitFor(() => expect(landed).toHaveBeenCalledTimes(1));
  });

  it('never has two saves out at once: a retry still waiting for an answer is not sent again', async () => {
    const extra = unexpected();
    // Matched by this, not by its variables, so the one retry that goes out is counted.
    const hangs = vi.fn((variables: Record<string, unknown>) => {
      return (variables.input as { expectedUpdatedAt?: string }).expectedUpdatedAt === loadedAt;
    });

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [
        loadedNote,
        typedSaveFails,
        { request: { query: UPDATE_NOTE }, variableMatcher: hangs, delay: Infinity, result: {} },
        extra.mock,
      ],
    });

    await typeAndFail();
    await advance(2000);
    await waitFor(() => expect(hangs).toHaveReturnedWith(true));

    act(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(60_000);

    expect(extra.sent).not.toHaveBeenCalled();
  });

  it('leaves a save the offline queue took to the queue, so it is not sent twice', async () => {
    const extra = unexpected();

    common.captureNote.mockImplementation(async (record: { captured_at: string }) => ({
      status: 'queued',
      record,
      id: 'row-9',
    }));
    common.connection = { mode: 'local' };

    const view = renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [loadedNote, typedSaveFails, extra.mock],
    });

    await typeAndFail();
    expect(await screen.findByText('Saved offline')).toBeInTheDocument();

    common.connection = { mode: 'connected' };
    view.rerender(<NotePage />);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await advance(60_000);

    expect(extra.sent).not.toHaveBeenCalled();
  });

  it('does not write over a version saved somewhere else meanwhile, and says so', async () => {
    const extra = unexpected();
    const refused = answer(false, '<p>Trip ideas, edited on the phone</p>', savedAt);

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [loadedNote, typedSaveFails, retried(loadedAt, { result: refused }), extra.mock],
    });

    await typeAndFail();
    await advance(2000);

    await waitFor(() => expect(refused).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Not saved.')).toHaveTextContent(
      'Not saved. This note was changed somewhere else. Copy your text, then reload.',
    );

    // Nothing more goes out from this page, retried or typed.
    await advance(60_000);
    type('<p>Trip ideas in May and June</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);

    expect(extra.sent).not.toHaveBeenCalled();
  });

  it("tells its own late save from someone else's and sends the newest text over it", async () => {
    const newer = '<p>Trip ideas in May and June</p>';
    // The first save's text, landed late after the gateway had given up on it.
    const lateAt = '2026-08-01T00:01:00.000Z';
    const ownLateSave = answer(false, typed, lateAt);
    const landed = answer(true, newer, savedAt);
    const newerInput = { id: noteGlobalId, content: newer, title: 'Trip ideas in May and June' };
    const guardedTypedSave = vi.fn(() => ({ errors: [{ message: '502 Bad Gateway' }] }));

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [
        loadedNote,
        typedSaveFails,
        // Typed while the first save waits to go again, so it holds that edit too and is guarded.
        {
          request: {
            query: UPDATE_NOTE,
            variables: { input: { ...newerInput, expectedUpdatedAt: loadedAt } },
          },
          result: guardedTypedSave,
        },
        {
          request: {
            query: UPDATE_NOTE,
            variables: { input: { ...newerInput, expectedUpdatedAt: loadedAt } },
          },
          result: ownLateSave,
        },
        {
          request: { query: UPDATE_NOTE, variables: { input: { ...newerInput, expectedUpdatedAt: lateAt } } },
          result: landed,
        },
      ],
    });

    await typeAndFail();
    type(newer);
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await waitFor(() => expect(common.captureNote).toHaveBeenCalledTimes(2));

    await advance(4000);

    await waitFor(() => expect(landed).toHaveBeenCalledTimes(1));
    expect(guardedTypedSave).toHaveBeenCalledTimes(1);
    expect(ownLateSave).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument());
  });

  it('stops sending it again once Memory says the note is gone, and says that instead', async () => {
    const extra = unexpected();
    const gone = vi.fn(() => ({
      data: { updateNote: { __typename: 'UpdateNotePayload', success: false, note: null } },
    }));

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [loadedNote, typedSaveFails, retried(loadedAt, { result: gone }), extra.mock],
    });

    await typeAndFail();
    await advance(2000);

    await waitFor(() => expect(gone).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Not saved. This note is no longer in your Memory.')).toBeInTheDocument();
    expect(screen.queryByText('Not saved yet.')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
    });
    await advance(60_000);

    expect(extra.sent).not.toHaveBeenCalled();
  });

  it('stops sending it again when Memory turns the save down, as an older Memory would the guard', async () => {
    const extra = unexpected();
    // What Apollo's HTTP link throws for a 400: GraphQL validation, here an unknown field.
    const badRequest = Object.assign(new Error('Response not successful: Received status code 400'), {
      statusCode: 400,
    });

    renderWithProviders(<NotePage />, {
      route: '/notes/abc-uuid',
      path: '/notes/:id',
      mocks: [loadedNote, typedSaveFails, retried(loadedAt, { error: badRequest }), extra.mock],
    });

    await typeAndFail();
    await advance(2000);

    expect(await screen.findByText('Not saved. Memory turned this save down (400).')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await advance(60_000);

    expect(extra.sent).not.toHaveBeenCalled();
  });

  it('does not create a new note that was emptied while its failed first save waited', async () => {
    const draftInput = {
      id: GlobalUID.encode('note', 'minted-note-id'),
      content: '<p>Grocery list</p>',
      title: 'Grocery list',
    };
    const createdAnyway = vi.fn(() => true);

    renderWithProviders(<NotePage />, {
      route: '/notes/new',
      path: '/notes/:id',
      mocks: [
        { request: { query: CREATE_NOTE, variables: { input: draftInput } }, error: gatewayError() },
        {
          request: { query: CREATE_NOTE },
          variableMatcher: createdAnyway,
          maxUsageCount: 99,
          result: { data: { createNote: { __typename: 'CreateNotePayload', success: false, note: null } } },
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type('<p>Grocery list</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await screen.findByText('Not saved yet.');

    type('<p></p>');
    await advance(60_000);

    expect(createdAnyway).not.toHaveBeenCalled();
    expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument();
  });

  it('creates a new note whose first save failed under the same id when it tries again', async () => {
    const draftInput = {
      id: GlobalUID.encode('note', 'minted-note-id'),
      content: '<p>Grocery list</p>',
      title: 'Grocery list',
    };
    const created = vi.fn(() => ({
      data: {
        createNote: {
          __typename: 'CreateNotePayload',
          success: true,
          note: {
            __typename: 'NoteType',
            id: draftInput.id,
            title: 'Grocery list',
            content: '<p>Grocery list</p>',
            updatedAt: savedAt,
          },
        },
      },
    }));

    renderWithProviders(<NotePage />, {
      route: '/notes/new',
      path: '/notes/:id',
      mocks: [
        { request: { query: CREATE_NOTE, variables: { input: draftInput } }, error: gatewayError() },
        { request: { query: CREATE_NOTE, variables: { input: draftInput } }, result: created },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    type('<p>Grocery list</p>');
    await advance(AUTOSAVE_THROTTLE_MS + 50);
    await waitFor(() => expect(common.captureNote).toHaveBeenCalledTimes(1));

    await advance(2000);

    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(common.newNoteId).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/notes/minted-note-id', { replace: true });
  });
});
