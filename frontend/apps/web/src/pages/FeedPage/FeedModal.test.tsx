import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { FeedModal } from './FeedModal';

const h = vi.hoisted(() => ({
  stop: vi.fn(),
  detach: vi.fn(),
  attach: vi.fn(async () => true),
  submit: vi.fn(async () => true),
  action: {
    id: 'a1',
    title: 'Pack lunch',
    text: 'Bring snacks',
    tags: [] as string[],
    threadId: 't1',
  },
  thread: { id: 't1', messages: [] as Array<{ role: string; content: string }>, generationStatus: 'idle' },
}));

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();

  return {
    ...actual,
    useActionService: () => [{ data: h.action, loading: false, error: null }],
    useThreadService: () => [{ thread: h.thread }],
  };
});

vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>();

  return {
    ...actual,
    useChatRequester: () => [
      { stream: null, loading: false, error: null, streaming: false, hasStartedReceiving: null },
      { submit: h.submit, attach: h.attach, detach: h.detach, stop: h.stop, cancel: vi.fn() },
    ],
  };
});

vi.mock('@/components/Chat', () => ({
  Chat: ({ autoFocus, messages }: { autoFocus?: boolean; messages?: Array<{ content: string }> }) => (
    <div
      data-testid="action-chat"
      data-autofocus={autoFocus ? 'true' : 'false'}
      data-messages={JSON.stringify((messages ?? []).map((message) => message.content))}
    >
      chat
    </div>
  ),
}));

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : query.includes('landscape') ? !mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function mountPageChrome() {
  const page = document.createElement('div');
  page.setAttribute('data-page-scroll', '');
  const scrollTo = vi.fn();
  page.scrollTo = scrollTo;
  document.body.append(page);

  const portal = document.createElement('div');
  portal.id = 'content-modal';
  document.body.append(portal);

  return { page, portal, scrollTo };
}

describe('FeedModal — mobile action chat', () => {
  let chrome: ReturnType<typeof mountPageChrome>;

  beforeEach(() => {
    setViewport(true);
    chrome = mountPageChrome();
  });

  afterEach(() => {
    chrome.page.remove();
    chrome.portal.remove();
    setViewport(false);
  });

  it('scrolls the page to the top, portals the dialog into view, and focuses the chat', async () => {
    renderWithProviders(<FeedModal />, { path: '/calendar/:id', route: '/calendar/a1' });

    const dialog = await waitFor(() => {
      const node = chrome.portal.querySelector('[role="dialog"]');
      expect(node).not.toBeNull();

      return node as HTMLElement;
    });

    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });

    expect(chrome.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
    expect(dialog).toHaveAttribute('aria-label', 'Pack lunch');
    expect(screen.getByTestId('action-chat')).toHaveAttribute('data-autofocus', 'true');
  });

  it('shows the action once when the thread the server opened already starts with it', async () => {
    h.thread.messages = [
      { role: 'assistant', content: 'Bring snacks' },
      { role: 'user', content: 'Why?' },
      { role: 'assistant', content: 'Because.' },
    ];

    try {
      renderWithProviders(<FeedModal />, { path: '/calendar/:id', route: '/calendar/a1' });

      expect(JSON.parse((await screen.findByTestId('action-chat')).dataset.messages ?? '[]')).toEqual([
        'Bring snacks',
        'Why?',
        'Because.',
      ]);
    } finally {
      h.thread.messages = [];
    }
  });
});

describe('FeedModal — desktop action window', () => {
  beforeEach(() => {
    setViewport(false);
  });

  it('does not open with focus on the Close button, whose tooltip would eat the first Esc', async () => {
    renderWithProviders(<FeedModal />, { path: '/today/:id', route: '/today/a1' });

    const dialog = await screen.findByRole('dialog');
    const close = screen.getByRole('button', { name: /close/i });

    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(close).not.toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The chat box is disabled while the action loads, so the Chat moves focus
    // into it once the action arrives.
    expect(screen.getByTestId('action-chat')).toHaveAttribute('data-autofocus', 'true');
  });
});
