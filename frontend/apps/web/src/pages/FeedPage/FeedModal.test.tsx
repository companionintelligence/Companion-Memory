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
}));

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();

  return {
    ...actual,
    useActionService: () => [{ data: h.action, loading: false, error: null }],
    useThreadService: () => [{ thread: { id: 't1', messages: [], generationStatus: 'idle' } }],
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
  Chat: ({ autoFocus }: { autoFocus?: boolean }) => (
    <div data-testid="action-chat" data-autofocus={autoFocus ? 'true' : 'false'}>
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
});
