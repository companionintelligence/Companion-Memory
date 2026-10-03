import { resetLocalLlmPrefsCache } from '@ci/common/src/utils/localLlmPrefs';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolsOffNotice } from './ToolsOffNotice';

const h = vi.hoisted(() => ({
  selectedModel: 'gemma3:1b' as string | null,
  activeModels: [] as Array<{ model: string; tools: boolean }>,
  loading: false,
  toolsSupported: false,
  toolsEnabled: false,
}));

vi.mock('@/hooks', () => ({
  useModel: () => [
    {
      selectedModel: h.selectedModel,
      activeModels: h.activeModels,
      loading: h.loading,
      toolsSupported: h.toolsSupported,
      toolsEnabled: h.toolsEnabled,
    },
    {},
  ],
}));

beforeEach(() => {
  h.selectedModel = 'gemma3:1b';
  h.activeModels = [
    { model: 'gemma3:1b', tools: false },
    { model: 'qwen3.5:4b', tools: true },
  ];
  h.loading = false;
  h.toolsSupported = false;
  h.toolsEnabled = false;
  localStorage.clear();
  resetLocalLlmPrefsCache();
});

describe('ToolsOffNotice', () => {
  // The iOS QA run: gemma3:1b, the default, has no tools, and chat on it invented
  // an Amazon purchase and claimed to have added a task. The model cannot be
  // trusted to say so; this line is the part that is always true.
  it('says a model without tools cannot look things up or make changes, and names the model', () => {
    render(<ToolsOffNotice />);

    const notice = screen.getByTestId('tools-off-notice');

    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent("gemma3:1b doesn't support tools");
    expect(notice).toHaveTextContent("can't look things up in your Memory or make changes");
    expect(notice).toHaveTextContent('wrench icon');
  });

  it('says so differently when the model has tools and the person switched them off', () => {
    h.selectedModel = 'qwen3.5:4b';
    h.toolsSupported = true;
    h.toolsEnabled = false;

    render(<ToolsOffNotice />);

    expect(screen.getByTestId('tools-off-notice')).toHaveTextContent('Tools are off');
    expect(screen.getByTestId('tools-off-notice')).not.toHaveTextContent("doesn't support");
  });

  it('is silent when chat has tools', () => {
    h.selectedModel = 'qwen3.5:4b';
    h.toolsSupported = true;
    h.toolsEnabled = true;

    render(<ToolsOffNotice />);

    expect(screen.queryByTestId('tools-off-notice')).toBeNull();
  });

  it('is silent until the model list has loaded: an unknown model is not a model without tools', () => {
    h.loading = true;
    const loading = render(<ToolsOffNotice />);

    expect(screen.queryByTestId('tools-off-notice')).toBeNull();
    loading.unmount();

    h.loading = false;
    h.selectedModel = null;
    const none = render(<ToolsOffNotice />);

    expect(screen.queryByTestId('tools-off-notice')).toBeNull();
    none.unmount();

    h.selectedModel = 'removed:7b';
    render(<ToolsOffNotice />);

    expect(screen.queryByTestId('tools-off-notice')).toBeNull();
  });

  it('is silent when the phone’s own model answers: the appliance’s tools are not what that chat uses', () => {
    localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ mode: 'device', modelId: 'qwen3-0.6b-int4' }));
    resetLocalLlmPrefsCache();

    render(<ToolsOffNotice />);

    expect(screen.queryByTestId('tools-off-notice')).toBeNull();
  });

  it('still speaks in auto mode, where the appliance answers first', () => {
    localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ mode: 'auto', modelId: 'qwen3-0.6b-int4' }));
    resetLocalLlmPrefsCache();

    render(<ToolsOffNotice />);

    expect(screen.getByTestId('tools-off-notice')).toBeInTheDocument();
  });
});
