import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelSelector } from './ModelSelector';

const h = vi.hoisted(() => ({
  selectedModel: 'qwen3:14b' as string | null,
  activeModels: [
    { model: 'qwen3:14b', thinking: true, tools: true, vision: false },
    { model: 'llama3.1:8b', thinking: false, tools: true, vision: false },
  ],
  loading: false,
  error: null as Error | null,
  thinkingSupported: true,
  thinkingEnabled: true,
  toolsSupported: true,
  toolsEnabled: true,
}));

vi.mock('@/hooks', () => ({
  useModel: () => [
    {
      selectedModel: h.selectedModel,
      selectedVisionModel: null,
      thinkingSupported: h.thinkingSupported,
      thinkingEnabled: h.thinkingEnabled,
      toolsSupported: h.toolsSupported,
      toolsEnabled: h.toolsEnabled,
      activeModels: h.activeModels,
      loading: h.loading,
      error: h.error,
    },
    {
      selectModel: vi.fn(),
      selectVisionModel: vi.fn(),
      toggleThinking: vi.fn(),
      toggleTools: vi.fn(),
    },
  ],
}));

beforeEach(() => {
  h.selectedModel = 'qwen3:14b';
  h.activeModels = [
    { model: 'qwen3:14b', thinking: true, tools: true, vision: false },
    { model: 'llama3.1:8b', thinking: false, tools: true, vision: false },
  ];
  h.loading = false;
  h.error = null;
  h.thinkingSupported = true;
  h.thinkingEnabled = true;
  h.toolsSupported = true;
  h.toolsEnabled = true;
});

describe('ModelSelector', () => {
  it('shows the served model id, not the Active model placeholder', () => {
    h.selectedModel = 'qwen3:14b';
    h.loading = false;
    h.error = null;

    render(<ModelSelector triggerClassName="w-full" />);

    expect(screen.getByRole('combobox', { name: 'Active model' })).toHaveTextContent('qwen3:14b');
    expect(screen.getByRole('combobox')).not.toHaveTextContent(/^Active model$/);
  });

  it('shows the served model id in the chat composer too', () => {
    h.selectedModel = 'qwen3:14b';

    render(<ModelSelector withToggles variant="composer" />);

    expect(screen.getByRole('combobox', { name: 'Active model' })).toHaveTextContent('qwen3:14b');
  });

  it('says when nothing is loaded yet instead of leaving the placeholder', () => {
    h.selectedModel = null;
    h.activeModels = [];
    h.loading = false;
    h.error = null;

    render(<ModelSelector />);

    expect(screen.getByRole('combobox', { name: 'Active model' })).toHaveTextContent('No models loaded');
  });
});
