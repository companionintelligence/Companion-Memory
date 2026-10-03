import { type ReactNode } from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelProvider, useModel } from './useModel';

const h = vi.hoisted(() => ({
  auth: {
    authToken: 'test-token' as string | null,
    authenticated: true,
    expired: false,
    loading: false,
    error: null,
  },
  toastError: vi.fn(),
}));

vi.mock('@ci/shadcn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/shadcn')>()),
  useToast: () => ({ toast: { error: h.toastError } }),
}));

vi.mock('./useAuth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => [h.auth, {}],
}));

const MODELS = [
  {
    model: 'llama3',
    namespace: null,
    name: 'Llama 3',
    tag: null,
    vision: false,
    tools: true,
    thinking: false,
  },
  {
    model: 'qwen-vl',
    namespace: null,
    name: 'Qwen VL',
    tag: null,
    vision: true,
    tools: true,
    thinking: true,
  },
];

/** Preference server state this mock serves and records writes into. */
interface ServerState {
  chatModel: string | null;
  toolsEnabled: boolean;
  thinkingEnabled: boolean;
}

function defaultServerState(): ServerState {
  return { chatModel: null, toolsEnabled: true, thinkingEnabled: true };
}

/**
 * Routes by URL, unlike the single-body mock this replaced: `fetchModels` now
 * fires four parallel requests (`/api/llm/models` plus the three preference
 * endpoints that used to be `localStorage`), and each needs its own response
 * for these tests to mean anything. POSTs to a preference endpoint mutate
 * `state` and echo it back, the way the real controller does.
 */
function setFetch(opts: { models?: unknown; modelsOk?: boolean; state?: ServerState } = {}) {
  const models = 'models' in opts ? opts.models : MODELS;
  const modelsOk = opts.modelsOk ?? true;
  const state = opts.state ?? defaultServerState();

  const respond = (body: unknown, ok = true) =>
    Promise.resolve({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) } as Response);

  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/llm/models')) {
      return respond(models, modelsOk);
    }

    if (url.includes('/api/personalization/chat-model')) {
      if (method === 'POST') {
        state.chatModel = (JSON.parse(String(init?.body)) as { chatModel: string | null }).chatModel;
      }

      return respond({ chatModel: state.chatModel });
    }

    if (url.includes('/api/personalization/tools')) {
      if (method === 'POST') {
        state.toolsEnabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      }

      return respond({ enabled: state.toolsEnabled });
    }

    if (url.includes('/api/personalization/thinking')) {
      if (method === 'POST') {
        state.thinkingEnabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      }

      return respond({ enabled: state.thinkingEnabled });
    }

    throw new Error(`useModel.test.tsx setFetch: unhandled URL ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);

  return { fetchMock, state };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ModelProvider args={[]}>{children}</ModelProvider>
);

beforeEach(() => {
  localStorage.clear();
  h.auth.authToken = 'test-token';
  h.auth.authenticated = true;
  h.auth.expired = false;
});
afterEach(() => vi.unstubAllGlobals());

describe('useModel', () => {
  it('loads models and selects the first when the user has no chat-model preference', async () => {
    setFetch();

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].activeModels).toHaveLength(2);
    expect(result.current[0].selectedModel).toBe('llama3');
  });

  it('restores the server-side chat-model preference when still available', async () => {
    setFetch({ state: { ...defaultServerState(), chatModel: 'qwen-vl' } });

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].selectedModel).toBe('qwen-vl'));
  });

  it('clears a stored chat-model preference that names a model no longer served', async () => {
    const { fetchMock, state } = setFetch({ state: { ...defaultServerState(), chatModel: 'removed:27b' } });

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    // The page shows the first served model, and the server is told so — no
    // stale name left behind to steer chat or the image-description default.
    expect(result.current[0].selectedModel).toBe('llama3');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/personalization/chat-model',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ chatModel: null }) }),
      ),
    );
    await waitFor(() => expect(state.chatModel).toBeNull());
  });

  it('does not clear a stored preference when the backend serves no models at all', async () => {
    const { fetchMock, state } = setFetch({
      models: [],
      state: { ...defaultServerState(), chatModel: 'qwen-vl' },
    });

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].selectedModel).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/personalization/chat-model',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(state.chatModel).toBe('qwen-vl');
  });

  it('selecting a model persists it to the server and (when vision-capable) also sets the vision model locally', async () => {
    const { fetchMock } = setFetch();
    const { result } = renderHook(() => useModel(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    act(() => result.current[1].selectModel('qwen-vl'));

    expect(result.current[0].selectedModel).toBe('qwen-vl');
    expect(result.current[0].selectedVisionModel).toBe('qwen-vl');
    // The vision-only picker (Capture modal) stays a local convenience.
    expect(localStorage.getItem('activeVisionModel')).toBe('qwen-vl');
    // The chat model itself is no longer written to localStorage at all.
    expect(localStorage.getItem('activeModel')).toBeNull();

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/personalization/chat-model',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ chatModel: 'qwen-vl' }) }),
      ),
    );
  });

  it('reverts the selection if the server rejects the write', async () => {
    const { fetchMock } = setFetch();
    const { result } = renderHook(() => useModel(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 500, text: async () => '{}' } as Response),
    );

    act(() => result.current[1].selectModel('qwen-vl'));
    expect(result.current[0].selectedModel).toBe('qwen-vl');

    await waitFor(() => expect(result.current[0].selectedModel).toBe('llama3'));
  });

  // The revert alone read as "the tap did nothing": an iOS QA run tapped a model
  // six times, the server answered 500 six times (an account with no self entity
  // to store the preference on), and the label snapped back to the default each
  // time with no word about why.
  it('says so when the server rejects the write, instead of reverting in silence', async () => {
    const { fetchMock } = setFetch();
    const { result } = renderHook(() => useModel(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 500, text: async () => '{}' } as Response),
    );

    act(() => result.current[1].selectModel('qwen-vl'));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/wasn't saved/));
    expect(result.current[0].selectedModel).toBe('llama3');
  });

  it('stays quiet when the write succeeds', async () => {
    const { fetchMock } = setFetch();
    const { result } = renderHook(() => useModel(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    act(() => result.current[1].selectModel('qwen-vl'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/personalization/chat-model',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('says so when the Tools or Thinking setting cannot be saved, and puts the toggle back', async () => {
    const { fetchMock } = setFetch();
    const { result } = renderHook(() => useModel(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));
    act(() => result.current[1].selectModel('qwen-vl'));
    await waitFor(() => expect(result.current[0].selectedModel).toBe('qwen-vl'));

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 500, text: async () => '{}' } as Response),
    );
    act(() => result.current[1].toggleTools());

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/Tools setting/)));
    await waitFor(() => expect(result.current[0].toolsEnabled).toBe(true));

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 500, text: async () => '{}' } as Response),
    );
    act(() => result.current[1].toggleThinking());

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/Thinking setting/)));
    await waitFor(() => expect(result.current[0].thinkingEnabled).toBe(true));
  });

  it('derives thinking/tools support from the selected model, and persists the toggle server-side', async () => {
    const { fetchMock } = setFetch();
    const { result } = renderHook(() => useModel(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    // Default selection llama3: tools yes, thinking no.
    expect(result.current[0].toolsSupported).toBe(true);
    expect(result.current[0].thinkingSupported).toBe(false);
    expect(result.current[0].thinkingEnabled).toBe(false); // preferred but unsupported

    act(() => result.current[1].selectModel('qwen-vl'));
    expect(result.current[0].thinkingSupported).toBe(true);
    expect(result.current[0].thinkingEnabled).toBe(true);

    act(() => result.current[1].toggleThinking());
    expect(result.current[0].thinkingEnabled).toBe(false);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/personalization/thinking',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ enabled: false }) }),
      ),
    );
  });

  it('restores the tools/thinking preferences from the server, not defaulted true', async () => {
    setFetch({ state: { ...defaultServerState(), toolsEnabled: false, thinkingEnabled: false } });

    const { result } = renderHook(() => useModel(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    act(() => result.current[1].selectModel('qwen-vl'));
    // Both preferred false; qwen-vl supports both, so "enabled" tracks the
    // stored preference exactly.
    expect(result.current[0].toolsEnabled).toBe(false);
    expect(result.current[0].thinkingEnabled).toBe(false);
  });

  it('surfaces an error when the model request fails', async () => {
    setFetch({ modelsOk: false });

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].error).toBeTruthy();
  });

  // Regression: an empty list is a normal recoverable backend state (Ollama
  // unreachable, no models pulled, LLM endpoint misconfigured). Indexing
  // `data[0].model` threw a TypeError that the surrounding try/catch turned into
  // a bogus `error`, so the UI reported a failure for a request that succeeded.
  it('handles an empty model list as an empty selection, not an error', async () => {
    setFetch({ models: [] });

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].error).toBeNull();
    expect(result.current[0].activeModels).toEqual([]);
    expect(result.current[0].selectedModel).toBeNull();
    expect(result.current[0].selectedVisionModel).toBeNull();
    expect(result.current[0].thinkingSupported).toBe(false);
    expect(result.current[0].toolsSupported).toBe(false);
  });

  // Regression: `fetchJson` casts the parsed body to `Model[]` without checking,
  // so a non-array payload reached `setActiveModels` and every later
  // `activeModels.find(...)` threw *during render* — outside the fetch try/catch.
  // ModelProvider wraps the whole routed tree in App.tsx, so that unmounted the
  // entire app: a blank page on every route, not just the model selector.
  it('tolerates a non-array payload without throwing during render', async () => {
    setFetch({ models: { error: 'llm endpoint misconfigured' } });

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].activeModels).toEqual([]);
    expect(result.current[0].selectedModel).toBeNull();
    expect(result.current[0].thinkingSupported).toBe(false);
  });

  // The empty list must not strand a stale selection: a model that is no
  // longer served cannot be used just because the user's preference names it.
  it('drops a chat-model preference that the server no longer lists', async () => {
    localStorage.setItem('activeVisionModel', 'qwen-vl');
    setFetch({ models: [], state: { ...defaultServerState(), chatModel: 'qwen-vl' } });

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].selectedModel).toBeNull();
    expect(result.current[0].selectedVisionModel).toBeNull();
  });

  // Native has no JWT. The phone used to skip this fetch and the composer
  // sat on "Couldn't load models" even with Ollama answering on the appliance.
  it('loads models when authenticated with no JWT (native API key session)', async () => {
    h.auth.authToken = null;
    h.auth.authenticated = true;
    const { fetchMock } = setFetch();

    const { result } = renderHook(() => useModel(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].activeModels).toHaveLength(2);
    expect(result.current[0].selectedModel).toBe('llama3');
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });
});
