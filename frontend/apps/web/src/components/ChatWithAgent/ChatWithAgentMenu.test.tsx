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

vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>();

  return { ...actual, useAuth: () => [{ authToken: 'test-token' }] };
});

const hermes: AgentHarnessStatus = {
  id: 'hermes',
  name: 'Hermes',
  connectedToMemory: true,
  installed: true,
  running: true,
  openUrl: 'https://hermes.example/chat',
  accessible: true,
  wakeable: false,
  dispatchReady: false,
  dispatchBlocker: 'chat_only',
  connectUrl: null,
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

  it('opens a menu even when no harness is connected', () => {
    renderWithProviders(<ChatWithAgentMenu context={{ title: 'Picnic', body: 'Bring snacks' }} />);

    const button = screen.getByRole('button', { name: 'Chat about “Picnic”' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(button);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('offers a menu when Hermes is installed', () => {
    h.harnesses = [hermes];

    renderWithProviders(<ChatWithAgentMenu context={{ title: 'Picnic', body: 'Bring snacks' }} />);

    expect(screen.getByRole('button', { name: 'Chat about “Picnic”' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    );
  });
});
