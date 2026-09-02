import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { MemoryChatAbout } from '@/components/ChatWithAgent';
import type { MemoryEntity } from '@/pages/MemoryPage/useEntityService';
import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  isMobile: false,
  navigate: vi.fn(),
  harnesses: [] as AgentHarnessStatus[],
}));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    useDeviceLayout: () => ({
      isMobile: h.isMobile,
      isLandscape: false,
      isPortrait: !h.isMobile,
      isMobileBrowser: h.isMobile,
    }),
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => h.navigate };
});

vi.mock('@/api/useAgentHarnesses', () => ({
  useAgentHarnesses: () => ({
    harnesses: h.harnesses,
    loading: false,
  }),
}));

vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>();

  return { ...actual, useAuth: () => [{ authToken: 'test-token' }] };
});

const note = {
  __typename: 'NoteType',
  id: 'note-1',
  title: 'Picnic',
  content: 'Bring snacks',
} as unknown as MemoryEntity;

const openclaw: AgentHarnessStatus = {
  id: 'openclaw',
  name: 'OpenClaw',
  connectedToMemory: true,
  installed: true,
  running: true,
  openUrl: 'https://openclaw.example/chat',
  accessible: true,
  wakeable: true,
  dispatchReady: true,
  dispatchBlocker: null,
  connectUrl: 'https://hub.example.com/api/memory-connect/start?app=ci-openclaw%3Aci-marketplace',
};

describe('MemoryChatAbout', () => {
  beforeEach(() => {
    h.isMobile = false;
    h.harnesses = [];
    h.navigate.mockReset();
    sessionStorage.clear();
    vi.spyOn(window, 'open').mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens a context menu with Open chat on right-click', async () => {
    renderWithProviders(
      <MemoryChatAbout entity={note}>
        <button type="button">Picnic note</button>
      </MemoryChatAbout>,
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Picnic note' }));

    expect(await screen.findByRole('menuitem', { name: 'Open chat' })).toBeInTheDocument();
  });

  it('navigates to in-app chat with the memory stashed', async () => {
    renderWithProviders(
      <MemoryChatAbout entity={note}>
        <button type="button">Picnic note</button>
      </MemoryChatAbout>,
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Picnic note' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open chat' }));

    expect(h.navigate).toHaveBeenCalledWith('/memory/chat');
    expect(JSON.parse(sessionStorage.getItem('ci.agentChat.seed') ?? '{}')).toMatchObject({
      title: 'Picnic',
      body: 'Bring snacks',
      sourceKind: 'NoteType',
      sourceId: 'note-1',
    });
  });

  it('offers OpenClaw when it is connected to Memory', async () => {
    h.harnesses = [openclaw];

    renderWithProviders(
      <MemoryChatAbout entity={note}>
        <button type="button">Picnic note</button>
      </MemoryChatAbout>,
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Picnic note' }));
    expect(await screen.findByRole('menuitem', { name: 'Dispatch to OpenClaw' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Chat in OpenClaw' }));

    await waitFor(() => expect(window.open).toHaveBeenCalled());
    const opened = new URL(String(vi.mocked(window.open).mock.calls[0]?.[0]));
    expect(opened.searchParams.get('prompt')).toContain('Picnic');
    expect(opened.searchParams.get('prompt')).toContain('Bring snacks');
    expect(opened.searchParams.get('memoryId')).toBe('note-1');
  });

  it('opens a bottom sheet on mobile long-press', async () => {
    h.isMobile = true;

    renderWithProviders(
      <MemoryChatAbout entity={note}>
        <button type="button">Picnic note</button>
      </MemoryChatAbout>,
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Picnic note' }));

    expect(await screen.findByRole('button', { name: 'Open chat' })).toBeInTheDocument();
  });
});
