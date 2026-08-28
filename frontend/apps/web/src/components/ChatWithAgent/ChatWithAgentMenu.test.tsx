import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ChatWithAgentMenu } from './ChatWithAgentMenu';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  harnesses: [] as AgentHarnessStatus[],
}));

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

const hermes: AgentHarnessStatus = {
  id: 'hermes',
  name: 'Hermes',
  connectedToMemory: true,
  installed: true,
  running: false,
  openUrl: 'https://hermes.example/chat',
  accessible: true,
};

describe('ChatWithAgentMenu', () => {
  beforeEach(() => {
    h.harnesses = [];
    h.navigate.mockReset();
    vi.spyOn(window, 'open').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chats here immediately when no harness is connected', () => {
    renderWithProviders(<ChatWithAgentMenu context={{ title: 'Picnic', body: 'Bring snacks' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat about “Picnic”' }));
    expect(h.navigate).toHaveBeenCalledWith('/memory/chat');
  });

  it('offers a connected Hermes even when it is not marked running', async () => {
    h.harnesses = [hermes];

    renderWithProviders(
      <ChatWithAgentMenu context={{ title: 'Picnic', body: 'Bring snacks' }} size="sm" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hermes' }));
    expect(window.open).toHaveBeenCalled();
    const opened = new URL(String(vi.mocked(window.open).mock.calls[0]?.[0]));
    expect(opened.origin).toBe('https://hermes.example');
    expect(opened.searchParams.get('prompt')).toContain('Picnic');
  });
});
