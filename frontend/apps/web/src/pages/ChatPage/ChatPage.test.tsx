import type { ReactNode } from 'react';

import { resetLocalLlmPrefsCache } from '@ci/common/src/utils/localLlmPrefs';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import ChatPage from './ChatPage';
import { STARTER_PROMPTS } from './starterPrompts';
import type { Message, Thread } from './types';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const h = vi.hoisted(() => ({
  stop: vi.fn(),
  detach: vi.fn(),
  attach: vi.fn(async () => true),
  submit: vi.fn(async () => true),
  cancel: vi.fn(),
  deleteThread: vi.fn(),
  reset: vi.fn(async () => {}),
  selectedModel: 'llama3' as string | null,
  local: null as null | { modelId: string; stats: Record<string, unknown> | null },
  threads: [
    { id: 't1', name: 'First', description: null },
    { id: 't2', name: 'Second', description: null, generationStatus: 'running' },
  ] as Thread[],
  thread: {
    id: 't1',
    name: 'First',
    model: 'm',
    description: null,
    generationStatus: 'idle',
    messages: [],
  } as unknown as Thread,
}));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    usePageTitle: () => undefined,
    resetLocalLlmConversation: (...args: unknown[]) => h.reset(...(args as [])),
    Portal: { Slot: ({ children }: { children: unknown }) => children },
  };
});

// ChatPage now renders inside MemoryHubShell (the shared Memory hub tab
// strip) — MemoryHubNav reads useFeatures(), which renderWithProviders
// deliberately does not supply (it fetches on mount).
vi.mock('@/common/feature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/feature')>();

  return { ...actual, useFeatures: () => ({ isFeatureEnabled: () => true }) };
});

vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>();

  return {
    ...actual,
    useChatRequester: () => [
      {
        stream: null,
        loading: false,
        error: null,
        streaming: false,
        hasStartedReceiving: null,
        local: h.local,
      },
      { submit: h.submit, attach: h.attach, detach: h.detach, stop: h.stop, cancel: h.cancel },
    ],
    useModel: () => [{ selectedModel: h.selectedModel }, {}],
    useCounter: () => [{ count: 0 }, { increment: vi.fn() }],
    // #2558 added `useAuth()` to ChatPageContent so a dispatch thread can call
    // /v1/agent/jobs. `renderWithProviders` deliberately provides no Auth
    // context (it fetches on mount), so from that commit every test in this
    // file threw before its first assertion — 10 of 10, red on `main` and
    // unnoticed because CI here is dispatch-only. Stubbed the way the harness'
    // own doc comment says to, and the way App.test.tsx already does.
    useAuth: () => [
      { expired: false, authToken: 'test-token', authenticated: true, loading: false, error: null },
      { login: vi.fn(), logout: vi.fn(), signup: vi.fn() },
    ],
  };
});

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();

  return {
    ...actual,
    useThreadService: () => [{ thread: h.thread, loading: false }, { refetch: vi.fn() }],
  };
});

vi.mock('./useThreadListService', () => ({
  useThreadListService: () => [
    { threads: h.threads, loading: false, error: null },
    { refetch: vi.fn(), delete: h.deleteThread },
  ],
}));

vi.mock('@/lib/agentChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agentChat')>();

  return {
    ...actual,
    readAgentChatContext: () => null,
    clearAgentChatContext: vi.fn(),
  };
});

// Stands in for the real composer: renders whatever ChatPage passes as the
// empty state and echoes `messages` so we can assert what a starter tap put
// into the thread.
vi.mock('@/components/Chat', () => ({
  Chat: ({
    onStop,
    emptyState,
    messages,
    disabled,
    localImages,
  }: {
    onStop?: () => void;
    emptyState?: ReactNode;
    messages?: Message[];
    disabled?: boolean;
    localImages?: boolean;
  }) => (
    <>
      <span data-testid="chat-disabled">{String(Boolean(disabled))}</span>
      <span data-testid="chat-local-images">{String(Boolean(localImages))}</span>
      <button type="button" onClick={() => onStop?.()}>
        Stop
      </button>
      <ul data-testid="thread-messages">
        {messages?.map((message) => <li key={message.id}>{`${message.role}: ${message.content}`}</li>)}
      </ul>
      {emptyState}
    </>
  ),
}));

describe('ChatPage', () => {
  beforeEach(() => {
    navigate.mockClear();
    h.submit.mockClear();
    h.stop.mockClear();
    h.detach.mockClear();
    h.attach.mockClear();
    h.cancel.mockClear();
    h.deleteThread.mockClear();
    h.reset.mockClear();
    h.selectedModel = 'llama3';
    h.local = null;
    localStorage.clear();
    resetLocalLlmPrefsCache();
    h.thread = {
      id: 't1',
      name: 'First',
      model: 'm',
      description: null,
      generationStatus: 'idle',
      messages: [],
    } as unknown as Thread;
  });

  it('detaches rather than stopping when selecting another thread', () => {
    renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

    fireEvent.click(screen.getByText('Second'));

    expect(h.stop).not.toHaveBeenCalled();
    expect(h.detach).toHaveBeenCalled();
  });

  it('attaches to a running thread when opening it', async () => {
    h.thread = {
      id: 't2',
      name: 'Second',
      description: null,
      generationStatus: 'running',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'hi',
          model: 'm',
          mimetype: null,
          toolCalls: null,
          canceled: false,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Hel',
          model: 'm',
          mimetype: null,
          toolCalls: null,
          canceled: false,
        },
      ],
    } as unknown as Thread;

    renderWithProviders(<ChatPage />, { route: '/memory/chat/t2', path: '/memory/chat/:id' });

    await waitFor(() => expect(h.attach).toHaveBeenCalledWith('t2'));
  });

  it('Stop still cancels the in-flight job', () => {
    renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

    fireEvent.click(screen.getByText('Stop'));

    expect(h.stop).toHaveBeenCalled();
  });

  it('cancels generation when a thread is deleted', () => {
    renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

    fireEvent.click(screen.getAllByLabelText('Delete thread')[0]);

    expect(h.cancel).toHaveBeenCalledWith('t1');
    expect(h.deleteThread).toHaveBeenCalledWith('t1');
  });

  /**
   * Deleting the thread that is currently open must leave the chat pointed at
   * something real — the composer would otherwise keep submitting against a
   * thread id the server no longer has, and every reply after the delete
   * would 404. handleDeleteThread only takes this branch when the deleted id
   * matches the one currently open (t1, per the route below).
   */
  it('navigates back to the empty chat list when the currently-open thread is deleted', () => {
    renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

    fireEvent.click(screen.getAllByLabelText('Delete thread')[0]); // t1 — the open thread

    expect(h.deleteThread).toHaveBeenCalledWith('t1');
    expect(navigate).toHaveBeenCalledWith('/memory/chat');
  });

  /**
   * The mirror case: deleting a thread from the sidebar while a *different*
   * thread is open (t2 here, not the open t1) must not knock the user out of
   * the conversation they're reading — only the matching-id branch navigates.
   */
  it('does not navigate away when a different thread is deleted from the sidebar', () => {
    renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

    fireEvent.click(screen.getAllByLabelText('Delete thread')[1]); // t2 — not open

    expect(h.cancel).toHaveBeenCalledWith('t2');
    expect(h.deleteThread).toHaveBeenCalledWith('t2');
    expect(navigate).not.toHaveBeenCalled();
  });

  describe('on-device model', () => {
    const renderNew = () =>
      renderWithProviders(<ChatPage />, { route: '/memory/chat', path: '/memory/chat' });

    it('shows nothing about the phone when the appliance answered', () => {
      renderNew();

      expect(screen.queryByTestId('on-device-badge')).toBeNull();
    });

    it('says the last reply came from this phone, with the model and its decode speed', () => {
      h.local = {
        modelId: 'gemma-4-e2b-it',
        stats: {
          timeToFirstTokenMs: 900,
          totalMs: 4000,
          outputTokens: 60,
          decodeTokensPerSecond: 19.24,
          tokensEstimated: false,
        },
      };
      renderNew();

      const badge = screen.getByTestId('on-device-badge');

      expect(badge).toHaveTextContent('Answered on this phone');
      expect(badge).toHaveTextContent('Gemma 4 E2B');
      expect(badge).toHaveTextContent('19.2 tok/s');
      expect(badge).toHaveTextContent('0.9s to first token');
    });

    it('marks a token rate that was estimated from chunks rather than counted', () => {
      h.local = {
        modelId: 'qwen3-0.6b-int4',
        stats: {
          timeToFirstTokenMs: 300,
          totalMs: 1000,
          outputTokens: 10,
          decodeTokensPerSecond: 12,
          tokensEstimated: true,
        },
      };
      renderNew();

      expect(screen.getByTestId('on-device-badge')).toHaveTextContent('(est.)');
    });

    it('shows the badge without numbers while the turn is still streaming', () => {
      h.local = { modelId: 'qwen3-0.6b-int4', stats: null };
      renderNew();

      const badge = screen.getByTestId('on-device-badge');

      expect(badge).toHaveTextContent('Answered on this phone · Qwen3 0.6B');
      expect(badge).not.toHaveTextContent('tok/s');
    });

    it('locks the composer with no appliance model — unless an on-device model can answer instead', () => {
      h.selectedModel = null;
      const locked = renderNew();

      expect(screen.getByTestId('chat-disabled')).toHaveTextContent('true');
      locked.unmount();

      localStorage.setItem(
        'ci.localLlm.prefs',
        JSON.stringify({ mode: 'device', modelId: 'qwen3-0.6b-int4' }),
      );
      resetLocalLlmPrefsCache();
      renderNew();

      expect(screen.getByTestId('chat-disabled')).toHaveTextContent('false');
    });

    it('keeps the composer locked when the mode is appliance-only, even with a model chosen', () => {
      h.selectedModel = null;
      localStorage.setItem(
        'ci.localLlm.prefs',
        JSON.stringify({ mode: 'appliance', modelId: 'qwen3-0.6b-int4' }),
      );
      resetLocalLlmPrefsCache();
      renderNew();

      expect(screen.getByTestId('chat-disabled')).toHaveTextContent('true');
    });

    it('lets a starter prompt send with no appliance model when the phone can answer', () => {
      h.selectedModel = null;
      localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ mode: 'auto', modelId: 'qwen3-0.6b-int4' }));
      resetLocalLlmPrefsCache();
      renderNew();

      fireEvent.click(screen.getByText(STARTER_PROMPTS[0]));

      expect(h.submit).toHaveBeenCalledWith({ message: STARTER_PROMPTS[0] });
    });

    it('reads photos on the phone only when the phone alone answers and its model can see', () => {
      const cases: Array<[string, string, string]> = [
        ['device', 'gemma-4-e2b-it', 'true'],
        ['device', 'qwen3-0.6b-int4', 'false'], // no vision
        ['auto', 'gemma-4-e2b-it', 'false'], // the appliance may answer, so attach uploads there
        ['appliance', 'gemma-4-e2b-it', 'false'],
      ];

      for (const [mode, modelId, expected] of cases) {
        localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ mode, modelId }));
        resetLocalLlmPrefsCache();

        const view = renderNew();

        expect(screen.getByTestId('chat-local-images'), `${mode}/${modelId}`).toHaveTextContent(expected);
        view.unmount();
      }
    });

    it('starts a fresh native conversation for a new chat, so turns do not leak between chats', () => {
      renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

      fireEvent.click(screen.getAllByText('New Thread')[0]);

      expect(h.reset).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh native conversation when another thread is opened', () => {
      renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

      fireEvent.click(screen.getByText('Second'));

      expect(h.reset).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The empty state only renders on `/memory/chat` — with an `:id` in the
   * route ChatPage is showing a thread, not the starting screen.
   */
  describe('empty state', () => {
    const renderEmpty = () =>
      renderWithProviders(<ChatPage />, { route: '/memory/chat', path: '/memory/chat' });

    /** Chat is the outer chat — it must not embed a second composer. */
    it('no longer embeds the How you’d do it composer', () => {
      renderEmpty();

      expect(screen.queryByLabelText('Task to personalize')).toBeNull();
      expect(screen.queryByText('How you’d do it')).toBeNull();
      expect(screen.queryByText('How I’d do this')).toBeNull();
    });

    it('offers about ten starter asks', () => {
      renderEmpty();

      expect(STARTER_PROMPTS.length).toBeGreaterThanOrEqual(9);
      expect(STARTER_PROMPTS.length).toBeLessThanOrEqual(12);

      for (const prompt of STARTER_PROMPTS) {
        expect(screen.getByRole('button', { name: prompt })).toBeInTheDocument();
      }
    });

    /**
     * Every starter is quoted verbatim from a backend intent's `phrases`, and
     * those are only sendable when they carry no `$slot` placeholder.
     */
    it('only offers starters that can be sent as-is', () => {
      for (const prompt of STARTER_PROMPTS) {
        expect(prompt).not.toMatch(/\$/);
      }
    });

    /** A tap has to send the ask, not just drop it in a box. */
    it('submits the ask when a starter is tapped', () => {
      renderEmpty();

      fireEvent.click(screen.getByRole('button', { name: STARTER_PROMPTS[0] }));

      expect(h.submit).toHaveBeenCalledWith({ message: STARTER_PROMPTS[0] });
    });

    /** …and the ask shows up as the user's turn, so the reply has context. */
    it('echoes the tapped ask into the thread as a user message', () => {
      renderEmpty();

      fireEvent.click(screen.getByRole('button', { name: STARTER_PROMPTS[1] }));

      expect(screen.getByText(`user: ${STARTER_PROMPTS[1]}`)).toBeInTheDocument();
    });
  });
});
