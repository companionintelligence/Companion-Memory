import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
  localMode: 'appliance' as 'appliance' | 'auto' | 'device',
  localModelId: null as string | null,
}));

vi.mock('@/hooks/useOnDeviceModel', () => ({
  useLocalLlmPrefs: () => [{ mode: h.localMode, modelId: h.localModelId }, vi.fn()],
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
  h.localMode = 'appliance';
  h.localModelId = null;
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

    expect(screen.getByRole('combobox', { name: 'Active model' })).toHaveTextContent('No model set up');
  });

  describe('with the phone answering', () => {
    it('names the on-device model in the composer instead of an appliance model that will not answer', () => {
      h.localMode = 'device';
      h.localModelId = 'gemma-4-e2b-it';

      render(
        <MemoryRouter>
          <ModelSelector withToggles variant="composer" />
        </MemoryRouter>,
      );

      const control = screen.getByRole('link', { name: 'Active model' });
      expect(control).toHaveTextContent('Gemma 4 E2B · on this phone');
      expect(control).toHaveAttribute('href', '/settings/on-device');
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      // The wrench and brain switch the appliance's tools and thinking; neither applies here.
      expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument();
    });

    it('says when on-device mode is set but no model has been chosen yet', () => {
      h.localMode = 'device';
      h.localModelId = null;

      render(
        <MemoryRouter>
          <ModelSelector withToggles variant="composer" />
        </MemoryRouter>,
      );

      expect(screen.getByRole('link', { name: 'Active model' })).toHaveTextContent(
        'Choose an on-device model',
      );
    });

    it('keeps the appliance picker in auto mode and marks the phone as the fallback', () => {
      h.localMode = 'auto';
      h.localModelId = 'gemma-4-e2b-it';

      render(<ModelSelector withToggles variant="composer" />);

      expect(screen.getByRole('combobox', { name: 'Active model' })).toHaveTextContent('qwen3:14b');
      expect(screen.getByTestId('on-device-fallback')).toBeInTheDocument();
    });

    it('leaves the Settings and Capture pickers on the appliance even in device mode', () => {
      h.localMode = 'device';
      h.localModelId = 'gemma-4-e2b-it';

      render(<ModelSelector triggerClassName="w-full" />);

      expect(screen.getByRole('combobox', { name: 'Active model' })).toHaveTextContent('qwen3:14b');
      expect(screen.queryByTestId('on-device-model')).not.toBeInTheDocument();
    });
  });
});
