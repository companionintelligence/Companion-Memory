import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentHarnessStatus } from '@/api/useAgentHarnesses';

import { AgentHarnessesSection } from './AgentHarnessesSection';

const h = vi.hoisted(() => ({
  harnesses: [] as AgentHarnessStatus[],
  loading: false,
  error: null as string | null,
  reload: vi.fn(),
}));

vi.mock('@/api/useAgentHarnesses', () => ({
  useAgentHarnesses: () => ({
    harnesses: h.harnesses,
    loading: h.loading,
    error: h.error,
    reload: h.reload,
  }),
}));

function harness(overrides: Partial<AgentHarnessStatus> = {}): AgentHarnessStatus {
  return {
    id: 'hermes',
    name: 'Hermes',
    connectedToMemory: false,
    installed: true,
    running: true,
    openUrl: 'https://hermes.example/chat',
    accessible: true,
    ...overrides,
  };
}

beforeEach(() => {
  h.harnesses = [];
  h.loading = false;
  h.error = null;
  h.reload.mockReset();
});

describe('AgentHarnessesSection', () => {
  it('renders all four booleans from a mocked harness status', () => {
    h.harnesses = [harness({ installed: true, connectedToMemory: false, running: true, accessible: true })];

    render(<AgentHarnessesSection />);

    expect(screen.getByText('Hermes')).toBeInTheDocument();
    expect(screen.getByText('Installed')).toHaveClass('text-foreground');
    expect(screen.getByText('Connected to Memory')).toHaveClass('text-muted-foreground');
    expect(screen.getByText('Running')).toHaveClass('text-foreground');
    expect(screen.getByText('Accessible')).toHaveClass('text-foreground');
  });

  it('disables Open without an openUrl', () => {
    h.harnesses = [harness({ openUrl: null, installed: true, running: true })];

    render(<AgentHarnessesSection />);

    const openButton = screen.getByRole('button', { name: /^Open Hermes/ });
    expect(openButton).toBeDisabled();
    expect(openButton).toHaveAccessibleName(/No open URL available/);
  });

  it('carries a disabled-reason tooltip for a not-running harness', () => {
    h.harnesses = [harness({ openUrl: 'https://hermes.example/chat', installed: true, running: false })];

    render(<AgentHarnessesSection />);

    const openButton = screen.getByRole('button', { name: /^Open Hermes/ });
    expect(openButton).toBeDisabled();
    expect(openButton).toHaveAccessibleName(/Not running — start it on your device first/);
  });

  it('enables Open and launches the harness URL with a generic context when running', () => {
    h.harnesses = [harness({ openUrl: 'https://hermes.example/chat', installed: true, running: true })];
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    render(<AgentHarnessesSection />);

    const openButton = screen.getByRole('button', { name: /^Open Hermes/ });
    expect(openButton).not.toBeDisabled();

    fireEvent.click(openButton);

    expect(openSpy).toHaveBeenCalled();
    const opened = new URL(String(openSpy.mock.calls[0]?.[0]));
    expect(opened.origin).toBe('https://hermes.example');
    expect(opened.searchParams.get('title')).toBe('Open Hermes');

    openSpy.mockRestore();
  });

  it('keeps Connect disabled with a reason — there is no in-app connect flow yet', () => {
    h.harnesses = [harness({ connectedToMemory: false })];

    render(<AgentHarnessesSection />);

    const connectButton = screen.getByRole('button', { name: /^Connect Hermes/ });
    expect(connectButton).toBeDisabled();
    expect(connectButton).toHaveAccessibleName(/no in-app flow/i);
  });

  it('shows a different Connect reason once already connected', () => {
    h.harnesses = [harness({ connectedToMemory: true })];

    render(<AgentHarnessesSection />);

    const connectButton = screen.getByRole('button', { name: /^Connect Hermes/ });
    expect(connectButton).toBeDisabled();
    expect(connectButton).toHaveAccessibleName(/already connected/i);
  });

  it('offers a retry when harnesses fail to load', () => {
    h.error = 'Could not load agent harnesses.';

    render(<AgentHarnessesSection />);

    expect(screen.getByText('Could not load agent harnesses.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});
