import type { ReactNode } from 'react';

import { FetchJsonError } from '@ci/common';
import { resetLocalLlmPrefsCache } from '@ci/common/src/utils/localLlmPrefs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Link } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import ChatPage from './ChatPage';
import { STARTER_PROMPTS, TOOL_STARTER_PROMPTS, starterPromptsFor } from './starterPrompts';
import type { Message, Thread } from './types';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const h = vi.hoisted(() => ({
  /** null = every flag on (the historical default of this suite); otherwise the flags that are. */
  flags: null as Record<string, boolean> | null,
  refetchModels: vi.fn(),
  modelsLoading: false,
  modelsError: null as Error | null,
  stop: vi.fn(),
  detach: vi.fn(),
  /** `useChatRequester().reset` — leaving a conversation (drops the stream and the on-device badge). */
  resetChat: vi.fn(),
  /** The options the page last handed `useChatRequester`, so a test can play the part of the first reply. */
  requesterOpts: null as null | { threadId: string | null; onNewThread?: (id: string) => void },
  isMobile: false,
  /** What `readAgentChatContext` hands the page once, as when "Chat about this" sent the person here. */
  seed: null as null | { title: string; body?: string },
  attach: vi.fn(async () => true),
  submit: vi.fn(async () => true),
  cancel: vi.fn(),
  deleteThread: vi.fn(),
  reset: vi.fn(async () => {}),
  selectedModel: 'llama3' as string | null,
  /** What `useModel` reports about tools; the starters list follows it. */
  activeModels: [{ model: 'llama3', tools: true }] as Array<{ model: string; tools: boolean }>,
  toolsSupported: true,
  toolsEnabled: true,
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
  } as unknown as Thread | null,
  /** What `useThreadService` says went wrong loading the open thread (`null`: nothing). */
  threadError: null as unknown,
  /** `useThreadService().refetch` — what Try again calls. */
  refetchThread: vi.fn(),
}));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    usePageTitle: () => undefined,
    useDeviceLayout: () => ({ isMobile: h.isMobile }),
    resetLocalLlmConversation: (...args: unknown[]) => h.reset(...(args as [])),
    Portal: { Slot: ({ children }: { children: unknown }) => children },
  };
});

// ChatPage now renders inside MemoryHubShell (the shared Memory hub tab
// strip) — MemoryHubNav reads useFeatures(), which renderWithProviders
// deliberately does not supply (it fetches on mount).
vi.mock('@/common/feature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/feature')>();

  return {
    ...actual,
    useFeatures: () => ({
      isFeatureEnabled: (flag: string) => (h.flags === null ? true : h.flags[flag] === true),
    }),
  };
});

vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>();

  return {
    ...actual,
    useChatRequester: (opts: { threadId: string | null; onNewThread?: (id: string) => void }) => {
      h.requesterOpts = opts;

      return [
        {
          stream: null,
          loading: false,
          error: null,
          streaming: false,
          hasStartedReceiving: null,
          local: h.local,
        },
        {
          submit: h.submit,
          attach: h.attach,
          detach: h.detach,
          reset: h.resetChat,
          stop: h.stop,
          cancel: h.cancel,
        },
      ];
    },
    useModel: () => [
      {
        selectedModel: h.selectedModel,
        activeModels: h.activeModels,
        toolsSupported: h.toolsSupported,
        toolsEnabled: h.toolsEnabled,
        loading: h.modelsLoading,
        error: h.modelsError,
      },
      { refetch: h.refetchModels },
    ],
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
    useThreadService: () => [
      { thread: h.thread, loading: false, error: h.threadError },
      { refetch: h.refetchThread },
    ],
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
    readAgentChatContext: () => {
      const seed = h.seed;

      h.seed = null; // the page clears the stash after reading it, so a second read finds nothing

      return seed;
    },
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
    blockUploads,
    initialDraft,
  }: {
    onStop?: () => void;
    emptyState?: ReactNode;
    messages?: Message[];
    disabled?: boolean;
    localImages?: boolean;
    blockUploads?: boolean;
    initialDraft?: string;
  }) => (
    <>
      <span data-testid="chat-draft">{initialDraft}</span>
      <span data-testid="chat-disabled">{String(Boolean(disabled))}</span>
      <span data-testid="chat-local-images">{String(Boolean(localImages))}</span>
      <span data-testid="chat-block-uploads">{String(Boolean(blockUploads))}</span>
      <button type="button" onClick={() => onStop?.()}>
        Stop
      </button>
      <ul data-testid="thread-messages">
        {messages?.map((message) => (
          <li key={message.id}>{`${message.role}: ${message.content}`}</li>
        ))}
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
    h.refetchModels.mockClear();
    h.flags = null;
    h.modelsLoading = false;
    h.modelsError = null;
    h.reset.mockClear();
    h.resetChat.mockClear();
    h.requesterOpts = null;
    h.isMobile = false;
    h.seed = null;
    h.selectedModel = 'llama3';
    h.activeModels = [{ model: 'llama3', tools: true }];
    h.toolsSupported = true;
    h.toolsEnabled = true;
    h.local = null;
    h.threadError = null;
    h.refetchThread.mockClear();
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

    // Leaving drops the stream (`reset` detaches, and clears the phone badge too) but must not cancel the job:
    // the server keeps generating and the thread shows the finished reply when it is opened again.
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.resetChat).toHaveBeenCalled();
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

  /**
   * A chat the server no longer has — deleted on another device, a stale link, the browser's Back button after a
   * delete — said "Could not load this conversation. Your messages are still here", which is untrue, with a Try
   * again that can only 404 again. A 404 is the one failure that is final, so it gets its own message and a way
   * back; anything else is still a failed fetch of a chat that exists.
   */
  describe('when the open chat cannot be loaded', () => {
    beforeEach(() => {
      h.thread = null;
    });

    const renderOpen = () =>
      renderWithProviders(<ChatPage />, { route: '/memory/chat/gone', path: '/memory/chat/:id' });

    it('says a chat the server no longer has was deleted, instead of blaming the connection', () => {
      h.threadError = new FetchJsonError(404, 'Not Found');
      renderOpen();

      const alert = screen.getByRole('alert');

      expect(within(alert).getByText('This chat was deleted.')).toBeInTheDocument();
      expect(within(alert).queryByText(/still here/i)).not.toBeInTheDocument();
      expect(within(alert).queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Could not load this conversation')).not.toBeInTheDocument();
    });

    it('offers New chat as the way back, and locks the composer a send could only 404 into', () => {
      h.threadError = new FetchJsonError(404, 'Not Found');
      renderOpen();

      expect(screen.getByTestId('chat-disabled')).toHaveTextContent('true');

      fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: /new chat/i }));

      expect(navigate).toHaveBeenCalledWith('/memory/chat');
      expect(h.resetChat).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the network is down', new TypeError('Failed to fetch')],
      ['the server errors', new FetchJsonError(500, 'Internal Server Error')],
      ['the session is not accepted', new FetchJsonError(401, 'Unauthorized')],
    ])('still blames the fetch, and offers Try again, when %s', (_label, error) => {
      h.threadError = error;
      renderOpen();

      const alert = screen.getByRole('alert');

      expect(within(alert).getByText('Could not load this conversation')).toBeInTheDocument();
      expect(screen.queryByText('This chat was deleted.')).not.toBeInTheDocument();
      expect(screen.getByTestId('chat-disabled')).toHaveTextContent('false');

      fireEvent.click(within(alert).getByRole('button', { name: /try again/i }));

      expect(h.refetchThread).toHaveBeenCalledTimes(1);
    });
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

    /**
     * The "Answered on this phone" badge lives in the requester's state, so leaving the chat has to clear it
     * there — it used to sit over the empty new chat and over an appliance thread the phone never answered.
     */
    it('drops the on-device badge and stream when a new chat is started', () => {
      renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

      fireEvent.click(screen.getAllByText('New Thread')[0]);

      expect(h.resetChat).toHaveBeenCalledTimes(1);
    });

    it('drops the on-device badge and stream when another thread is opened', () => {
      renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

      fireEvent.click(screen.getByText('Second'));

      expect(h.resetChat).toHaveBeenCalledTimes(1);
    });

    /**
     * The phone drawer's thread rows are plain router links, not the sidebar's `onSelectThread`, so nothing
     * but the route change itself says the conversation changed.
     */
    it('leaves the previous conversation behind when the route moves to another thread', () => {
      renderWithProviders(
        <>
          <Link to="/memory/chat/t2">drawer: Second</Link>
          <ChatPage />
        </>,
        { route: '/memory/chat/t1', path: '/memory/chat/:id?' },
      );
      expect(h.resetChat).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('drawer: Second'));

      expect(h.resetChat).toHaveBeenCalledTimes(1);
      expect(h.reset).toHaveBeenCalledTimes(1);
    });

    it('does not reset anything just because the page mounted', () => {
      renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id?' });

      expect(h.resetChat).not.toHaveBeenCalled();
      expect(h.reset).not.toHaveBeenCalled();
    });

    /**
     * The first message of a new chat moves the address bar to its thread WITHOUT telling the router (so the
     * stream is not torn down). The router therefore still believes it is on the bare chat path, and a link to
     * that path — the Chat row in the drawer, the Chat tab on every Memory page — landed on "where it already
     * was": nothing happened, and the chat kept its thread.
     */
    it('starts a new chat when the Chat link is followed after the first message', () => {
      renderWithProviders(
        <>
          <Link to="/memory/chat">drawer: Chat</Link>
          <ChatPage />
        </>,
        { route: '/memory/chat', path: '/memory/chat/:id?' },
      );

      // The first reply creates a thread; the page records it without a router navigation.
      act(() => h.requesterOpts?.onNewThread?.('t9'));
      expect(h.resetChat).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('drawer: Chat'));

      expect(h.resetChat).toHaveBeenCalledTimes(1);
      expect(h.reset).toHaveBeenCalledTimes(1);
      // …and the composer is now talking to no thread at all.
      expect(h.requesterOpts?.threadId).toBeNull();
      expect(screen.getByRole('button', { name: STARTER_PROMPTS[0] })).toBeInTheDocument();
    });

    // "Always answer on this phone" never creates a server thread, so there is no thread id to go on — the
    // on-device badge is what says a turn has happened in this chat.
    it('starts a new chat when the Chat link is followed after an on-device turn, which has no thread', () => {
      h.local = { modelId: 'qwen3-0.6b-int4', stats: null };
      renderWithProviders(
        <>
          <Link to="/memory/chat">drawer: Chat</Link>
          <ChatPage />
        </>,
        { route: '/memory/chat', path: '/memory/chat/:id?' },
      );

      fireEvent.click(screen.getByText('drawer: Chat'));

      expect(h.resetChat).toHaveBeenCalledTimes(1);
      expect(h.reset).toHaveBeenCalledTimes(1);
    });

    /**
     * "Chat about this" seeds the composer once. That seed belongs to the chat it opened: the next new chat must
     * start with an empty composer, not the old ask coming back.
     */
    it('does not bring a seeded draft back into the next new chat', () => {
      h.seed = { title: 'Picnic', body: 'Bring snacks' };
      renderWithProviders(
        <>
          <Link to="/memory/chat">drawer: Chat</Link>
          <ChatPage />
        </>,
        { route: '/memory/chat', path: '/memory/chat/:id?' },
      );

      expect(screen.getByTestId('chat-draft')).toHaveTextContent('Picnic');

      act(() => h.requesterOpts?.onNewThread?.('t9'));
      fireEvent.click(screen.getByText('drawer: Chat'));

      expect(screen.getByTestId('chat-draft')).toBeEmptyDOMElement();
    });

    it('leaves an empty chat alone when the Chat link is followed (there is nothing to start over)', () => {
      renderWithProviders(
        <>
          <Link to="/memory/chat">drawer: Chat</Link>
          <ChatPage />
        </>,
        { route: '/memory/chat', path: '/memory/chat/:id?' },
      );

      fireEvent.click(screen.getByText('drawer: Chat'));

      expect(h.resetChat).not.toHaveBeenCalled();
    });

    /**
     * A tapped starter is echoed into the page's own message list, so starting over has to empty that too — it
     * is not part of the chat component that remounts.
     */
    it('does not carry a tapped starter into the next new chat', () => {
      renderWithProviders(
        <>
          <Link to="/memory/chat">drawer: Chat</Link>
          <ChatPage />
        </>,
        { route: '/memory/chat', path: '/memory/chat/:id?' },
      );

      fireEvent.click(screen.getByRole('button', { name: STARTER_PROMPTS[2] }));
      expect(screen.getByText(`user: ${STARTER_PROMPTS[2]}`)).toBeInTheDocument();

      act(() => h.requesterOpts?.onNewThread?.('t9'));
      fireEvent.click(screen.getByText('drawer: Chat'));

      expect(screen.queryByText(`user: ${STARTER_PROMPTS[2]}`)).not.toBeInTheDocument();
    });

    /**
     * "Always answer on this phone" promises nothing leaves the device, yet attach uploads at once. Only a
     * phone model that can read photos has anything to do with an attachment (it reads them locally); with any
     * other mode the appliance is a legitimate destination, or the mode does not apply.
     */
    it('blocks uploads only when the phone alone answers and its model cannot read photos', () => {
      const cases: Array<[string, string, string]> = [
        ['device', 'qwen3-0.6b-int4', 'true'], // nothing local can read a file: attach would only upload
        ['device', 'gemma-4-e2b-it', 'false'], // photos are read on the phone, never uploaded
        ['auto', 'qwen3-0.6b-int4', 'false'], // the appliance may answer, so attach uploads there on purpose
        ['appliance', 'qwen3-0.6b-int4', 'false'],
      ];

      for (const [mode, modelId, expected] of cases) {
        localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ mode, modelId }));
        resetLocalLlmPrefsCache();

        const view = renderNew();

        expect(screen.getByTestId('chat-block-uploads'), `${mode}/${modelId}`).toHaveTextContent(expected);
        view.unmount();
      }
    });

    /**
     * Time to first token is the last thing on the line and the one number that says whether the phone is coping,
     * and on a 402pt screen it ended in an ellipsis. It wraps instead.
     */
    it('lets the speed readout wrap rather than cutting it off with an ellipsis', () => {
      h.local = {
        modelId: 'qwen3-0.6b-int4',
        stats: {
          timeToFirstTokenMs: 1200,
          totalMs: 4000,
          outputTokens: 60,
          decodeTokensPerSecond: 13,
          tokensEstimated: true,
        },
      };
      renderNew();

      const badge = screen.getByTestId('on-device-badge');

      expect(badge).toHaveTextContent('1.2s to first token');
      expect(badge.querySelector('.truncate')).toBeNull();
    });
  });

  /**
   * The desktop gets `ChatSidebar`, portaled into a slot the phone layout never renders — so the phone had no
   * New Thread control at all, and its only list of past chats was nested in the drawer.
   */
  describe('on a phone', () => {
    beforeEach(() => {
      h.isMobile = true;
    });

    it('offers New chat and a list of past chats in the page itself', () => {
      renderWithProviders(<ChatPage />, { route: '/memory/chat', path: '/memory/chat' });

      expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^chats$/i })).toBeInTheDocument();
    });

    it('starts over from New chat, from any point in a conversation', () => {
      renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

      fireEvent.click(screen.getByRole('button', { name: /new chat/i }));

      expect(navigate).toHaveBeenCalledWith('/memory/chat');
      expect(h.reset).toHaveBeenCalledTimes(1);
      expect(h.resetChat).toHaveBeenCalledTimes(1);
    });

    it('opens a past chat from the list', () => {
      renderWithProviders(<ChatPage />, { route: '/memory/chat/t1', path: '/memory/chat/:id' });

      fireEvent.click(screen.getByRole('button', { name: /^chats$/i }));
      // The desktop sidebar is rendered inline by this file's Slot stub, so scope to the phone's list.
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Second' }));

      expect(navigate).toHaveBeenCalledWith('/memory/chat/t2');
      expect(h.resetChat).toHaveBeenCalledTimes(1);
    });

    it('is not drawn on the desktop layout, which has the sidebar', () => {
      h.isMobile = false;
      renderWithProviders(<ChatPage />, { route: '/memory/chat', path: '/memory/chat' });

      expect(screen.queryByRole('button', { name: /new chat/i })).not.toBeInTheDocument();
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

    /**
     * A stock install has neither Today (the Brief surface) nor Forecast, so
     * offering asks about them teaches the user features they cannot see.
     */
    it('leaves out starters about surfaces this appliance has switched off', () => {
      h.flags = { 'insights.page': true, 'import.page': true, 'planning.page': true };
      renderEmpty();

      for (const gone of [
        'What is on Brief',
        'Any suggested actions',
        'What does tomorrow look like for me',
        'How accurate are my predictions',
      ]) {
        expect(screen.queryByRole('button', { name: gone })).toBeNull();
      }

      expect(screen.getByRole('button', { name: 'Who is my family' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'How is my import going' })).toBeInTheDocument();
    });

    it('brings the Brief and Forecast starters back when their pages are on', () => {
      h.flags = { 'today.page': true, 'forecast.page': true };
      renderEmpty();

      expect(screen.getByRole('button', { name: 'What is on Brief' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'What does tomorrow look like for me' })).toBeInTheDocument();
    });

    it('does not name pages that are off in the composer hint or the intro line', () => {
      h.flags = { 'planning.page': true };
      renderEmpty();

      expect(screen.getByText('Ask about Memory or Plan — or attach a file')).toBeInTheDocument();
    });

    it('starterPromptsFor keeps the ungated starters when every flag is off', () => {
      expect(starterPromptsFor(() => false)).toEqual([
        'Anything unusual lately',
        'Where do I usually go next',
        'Who is my family',
        'What are my preferences',
      ]);
    });

    /** …and the ask shows up as the user's turn, so the reply has context. */
    it('echoes the tapped ask into the thread as a user message', () => {
      renderEmpty();

      fireEvent.click(screen.getByRole('button', { name: STARTER_PROMPTS[1] }));

      expect(screen.getByText(`user: ${STARTER_PROMPTS[1]}`)).toBeInTheDocument();
    });

    /**
     * With no model the composer and every starter used to be disabled and the
     * page said nothing — the fix (Settings → Model) was two screens away.
     */
    describe('with no model', () => {
      it('explains itself and links to Settings → Model instead of showing dead starters', () => {
        h.selectedModel = null;
        renderEmpty();

        const state = screen.getByTestId('chat-no-model');
        expect(state).toHaveTextContent('Chat needs a model');

        const link = screen.getByRole('link', { name: /Open Settings → Model/ });
        expect(link.getAttribute('href')).toMatch(/\/settings\/model$/);

        expect(screen.queryByRole('list', { name: 'Suggested asks' })).toBeNull();
      });

      it('distinguishes an unreachable model server from an empty one, and offers a retry', () => {
        h.selectedModel = null;
        h.modelsError = new Error('down');
        renderEmpty();

        expect(screen.getByTestId('chat-no-model')).toHaveTextContent('Chat can’t reach a model');

        fireEvent.click(screen.getByRole('button', { name: /Check again/ }));
        expect(h.refetchModels).toHaveBeenCalledTimes(1);
      });

      it('does not flash the setup prompt while the model list is still loading', () => {
        h.selectedModel = null;
        h.modelsLoading = true;
        renderEmpty();

        expect(screen.queryByTestId('chat-no-model')).toBeNull();
      });

      it('still shows the starters once a model is selected', () => {
        renderEmpty();

        expect(screen.queryByTestId('chat-no-model')).toBeNull();
        expect(screen.getByRole('list', { name: 'Suggested asks' })).toBeInTheDocument();
      });
    });

    /**
     * Five of the ten need a tool: "Where do I usually go next" answered by a
     * model with none came back as a made-up place, a literal `tool_code` block,
     * or the bare word "Brief.list". A sixth, "What is on Brief", is in the
     * snapshots but is still invented on a 1B model. With tools off the page
     * offers the ones the snapshots can answer reliably, and nothing the model
     * cannot.
     */
    describe('when chat has no tools', () => {
      const noTools = () => {
        h.toolsSupported = false;
        h.toolsEnabled = false;
        h.activeModels = [{ model: 'llama3', tools: false }];
      };

      it('names exactly the starters that need a tool, and they are real starters', () => {
        expect(TOOL_STARTER_PROMPTS.size).toBe(6);

        for (const prompt of TOOL_STARTER_PROMPTS) {
          expect(STARTER_PROMPTS).toContain(prompt);
        }
      });

      it('offers only the starters the snapshots can answer when the model has no tools', () => {
        noTools();
        renderEmpty();

        for (const prompt of STARTER_PROMPTS) {
          const button = screen.queryByRole('button', { name: prompt });

          if (TOOL_STARTER_PROMPTS.has(prompt)) {
            expect(button, prompt).toBeNull();
          } else {
            expect(button, prompt).toBeInTheDocument();
          }
        }
      });

      it('does the same when the person switched the wrench off on a model that has tools', () => {
        h.toolsEnabled = false;
        renderEmpty();

        expect(screen.queryByRole('button', { name: 'Where do I usually go next' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'What is on Brief' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Who is my family' })).toBeInTheDocument();
      });

      it('offers every starter while the model list is still loading, rather than flashing a short one', () => {
        noTools();
        h.selectedModel = null;
        h.modelsLoading = true;
        h.activeModels = [];
        renderEmpty();

        for (const prompt of STARTER_PROMPTS) {
          expect(screen.getByRole('button', { name: prompt })).toBeInTheDocument();
        }
      });

      it('offers every starter when the phone’s own model answers, whatever the appliance model can do', () => {
        noTools();
        localStorage.setItem(
          'ci.localLlm.prefs',
          JSON.stringify({ mode: 'device', modelId: 'qwen3-0.6b-int4' }),
        );
        resetLocalLlmPrefsCache();
        renderEmpty();

        for (const prompt of STARTER_PROMPTS) {
          expect(screen.getByRole('button', { name: prompt })).toBeInTheDocument();
        }
      });
    });
  });
});
