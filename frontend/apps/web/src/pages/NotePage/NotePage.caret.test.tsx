import { useRef, type ReactNode } from 'react';

import { GlobalUID } from '@ci/common';
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { NotePage } from './NotePage';

/**
 * Creating a note navigates from `/notes/new` to its id, and that is the moment
 * the chat control mounts. Remounting the editor there focuses it at the start
 * of the document. These tests drive the mocked editor and assert that handoff
 * keeps the same instance and does not push the saved HTML back in.
 */

const AUTOSAVE_THROTTLE_MS = 1000;

const editorState = vi.hoisted(() => ({
  mounts: 0,
  contents: [] as Array<string | undefined>,
  onUpdate: undefined as ((content: string) => void) | undefined,
}));

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => <div>Chat about this</div>,
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
    const mounted = useRef(false);

    if (!mounted.current) {
      mounted.current = true;
      editorState.mounts += 1;
    }

    editorState.contents.push(content);
    editorState.onUpdate = onUpdate;

    return <>{children}</>;
  }

  MockEditor.Menu = ({ children }: { children?: ReactNode }) => <>{children}</>;
  MockEditor.Content = () => null;

  return { Editor: MockEditor };
});

vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  captureNote: vi.fn(),
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

function type(content: string) {
  act(() => editorState.onUpdate?.(content));
}

async function flushAutosave() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_THROTTLE_MS + 50));
  });
}

beforeEach(() => {
  editorState.mounts = 0;
  editorState.contents = [];
  editorState.onUpdate = undefined;
});

describe('NotePage editor caret', () => {
  it('keeps the editor mounted when the saved note and its chat control appear', async () => {
    const noteGlobalId = GlobalUID.encode('note', 'minted-note-id');
    const content = '<p>Grocery list</p>';

    renderWithProviders(<NotePage />, {
      route: '/notes/new',
      path: '/notes/:id',
      mocks: [
        {
          request: {
            query: CREATE_NOTE,
            variables: { input: { content, title: 'Grocery list' } },
          },
          result: {
            data: {
              createNote: {
                __typename: 'CreateNotePayload',
                success: true,
                note: {
                  __typename: 'NoteType',
                  id: noteGlobalId,
                  title: 'Grocery list',
                  content,
                  updatedAt: '2026-08-18T00:00:00.000Z',
                },
              },
            },
          },
        },
        {
          request: { query: GET_NOTE, variables: { id: noteGlobalId } },
          result: {
            data: {
              note: {
                __typename: 'NoteType',
                id: noteGlobalId,
                title: 'Grocery list',
                content,
                updatedAt: '2026-08-18T00:00:00.000Z',
              },
            },
          },
        },
      ],
    });

    await waitFor(() => expect(editorState.onUpdate).toBeDefined());
    const mountsWhileTyping = editorState.mounts;

    type(content);
    await flushAutosave();

    // The chat control is the thing that shows up in the corner once the note exists.
    expect(await screen.findByText('Chat about this')).toBeInTheDocument();
    expect(editorState.mounts).toBe(mountsWhileTyping);
    expect(editorState.contents.every((value) => value === undefined)).toBe(true);
  });
});
