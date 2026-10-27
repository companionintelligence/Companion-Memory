import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createHookContext, fetchJson } from '@ci/common';
import { useToast } from '@ci/shadcn';

import { useSessionAuth } from './useSessionAuth';

// The Capture modal's own manual model picker (choosing, for one photo right
// now, which model analyses it) stays a per-browser convenience — it is a
// distinct, interactive-only concept from the Settings → Model chat model
// below, which is now a server-side preference so it survives a cleared
// profile, follows the user across devices, and is visible to background
// vision work (OllamaService.resolveVisionModel), not just this browser tab.
const ACTIVE_VISION_MODEL_KEY = 'activeVisionModel';

interface Model {
  model: string;
  namespace: string | null;
  name: string;
  tag: string | null;
  capabilities?: string[];
  vision?: boolean;
  tools?: boolean;
  thinking?: boolean;
}

type Value = [
  {
    selectedModel: string | null;
    selectedVisionModel: string | null;
    /**
     * Bumped each time the server confirms a chat-model switch. Settings that
     * belong to the model (Describe images) reload on it: reloading on
     * `selectedModel` alone would race the save and read the old model's value.
     */
    chatModelRevision: number;
    /**
     * True while a chat-model switch is on its way to the server. Until it
     * lands, a per-model setting on screen still belongs to the old model, and
     * changing it would be saved for whichever model the server has by then.
     */
    chatModelSaving: boolean;
    thinkingSupported: boolean;
    thinkingEnabled: boolean;
    toolsSupported: boolean;
    toolsEnabled: boolean;
    activeModels: Model[];
    loading: boolean;
    error: Error | null;
  },
  {
    selectModel: (model: string | null) => void;
    selectVisionModel: (model: string | null) => void;
    toggleThinking: () => void;
    toggleTools: () => void;
    refetch: () => void;
  },
];

function useModel(): Value {
  const { ready, headers } = useSessionAuth();
  const { toast } = useToast();

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedVisionModel, setSelectedVisionModel] = useState<string | null>(null);
  const [activeModels, setActiveModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [toolsPreferred, setToolsPreferred] = useState<boolean>(true);
  const [thinkingPreferred, setThinkingPreferred] = useState<boolean>(true);
  const [chatModelRevision, setChatModelRevision] = useState<number>(0);
  const [chatModelSaves, setChatModelSaves] = useState<number>(0);

  const initialRequestRef = useRef<boolean>(false);

  const selectModel = useCallback(
    (model: string | null) => {
      const previous = selectedModel;

      setSelectedModel(model);

      const selected = activeModels.find((m) => m.model === model);

      if (selected?.vision) {
        setSelectedVisionModel(model);

        if (model) {
          localStorage.setItem(ACTIVE_VISION_MODEL_KEY, model);
        }
      }

      // Fire-and-forget from the caller's point of view (ModelSelector calls
      // this synchronously from an onValueChange handler) — revert the
      // optimistic update on failure rather than leaving the UI showing a
      // model the server never actually recorded. And say so: the revert alone
      // looked like the tap had done nothing (six taps, six silent reverts, on
      // an iOS QA run whose account the server could not write for).
      setChatModelSaves((saves) => saves + 1);
      void fetchJson('/api/personalization/chat-model', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatModel: model }),
      })
        .then(() => setChatModelRevision((revision) => revision + 1))
        .catch(() => {
          setSelectedModel(previous);
          toast.error("Couldn't switch models — your choice wasn't saved. Try again.");
        })
        .finally(() => setChatModelSaves((saves) => saves - 1));
    },
    [activeModels, headers, selectedModel, toast],
  );

  const selectVisionModel = useCallback((model: string | null) => {
    setSelectedVisionModel(model);

    if (model) {
      localStorage.setItem(ACTIVE_VISION_MODEL_KEY, model);
    } else {
      localStorage.removeItem(ACTIVE_VISION_MODEL_KEY);
    }
  }, []);

  const toggleThinking = useCallback(() => {
    setThinkingPreferred((current) => {
      const next = !current;

      void fetchJson('/api/personalization/thinking', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      }).catch(() => {
        setThinkingPreferred(current);
        toast.error("Couldn't save the Thinking setting. Try again.");
      });

      return next;
    });
  }, [headers, toast]);

  const toggleTools = useCallback(() => {
    setToolsPreferred((current) => {
      const next = !current;

      void fetchJson('/api/personalization/tools', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      }).catch(() => {
        setToolsPreferred(current);
        toast.error("Couldn't save the Tools setting. Try again.");
      });

      return next;
    });
  }, [headers, toast]);

  const fetchModels = useCallback(async () => {
    setActiveModels([]);
    setLoading(true);
    setError(null);

    try {
      const requestHeaders = { 'Content-Type': 'application/json', ...headers };
      // In parallel: the served model list, and the three preferences that
      // used to be `localStorage`. A preference fetch failing (a fresh
      // profile, a transient 500) degrades to that preference's own
      // long-standing default rather than failing the whole model list.
      const [payload, chatModelPref, toolsPref, thinkingPref] = await Promise.all([
        fetchJson<Model[]>('/api/llm/models', { method: 'GET', headers: requestHeaders }),
        fetchJson<{ chatModel: string | null; defaultChatModel?: string | null }>(
          '/api/personalization/chat-model',
          { headers: requestHeaders },
        ).catch(() => ({ chatModel: null, defaultChatModel: null })),
        fetchJson<{ enabled: boolean }>('/api/personalization/tools', { headers: requestHeaders }).catch(
          () => ({ enabled: true }),
        ),
        fetchJson<{ enabled: boolean }>('/api/personalization/thinking', { headers: requestHeaders }).catch(
          () => ({ enabled: true }),
        ),
      ]);

      // An empty or malformed list is a recoverable backend state, not a client
      // error: Ollama may be unreachable, have no models pulled, or the endpoint
      // may be misconfigured. `fetchJson` casts the parsed body to `Model[]`
      // without checking it, so normalise once here — `activeModels` is read with
      // `.find` during render (thinkingSupported / toolsSupported), which is
      // outside this try/catch, and ModelProvider wraps the whole routed tree.
      const data = Array.isArray(payload) ? payload : [];

      setActiveModels(data);
      setToolsPreferred(toolsPref?.enabled !== false);
      setThinkingPreferred(thinkingPref?.enabled !== false);

      const persistedModel = chatModelPref?.chatModel ?? null;
      const persistedIsServed = persistedModel != null && data.some((m) => m.model === persistedModel);
      // With no usable personal choice, the appliance default (the model the
      // Hub configured) is what a turn should run on. Taking the first entry of
      // the list instead sent whatever `ollama list` put first, which is often
      // the most recently pulled model (gemma3:270m on a Hub defaulting to
      // qwen3.5:9b), and the page sends its selection with every turn.
      const defaultModel = chatModelPref?.defaultChatModel ?? null;
      const defaultIsServed = defaultModel != null && data.some((m) => m.model === defaultModel);
      const model = persistedIsServed
        ? persistedModel
        : defaultIsServed
          ? defaultModel
          : (data[0]?.model ?? null);

      setSelectedModel(model);

      // A stored preference naming a model the backend no longer serves (the
      // tag was removed or renamed under it). Showing the first served model
      // as "selected" while the server keeps the stale name was actively
      // misleading: the page looked right, there was no click that would
      // rewrite it, and the server went on steering by it — chat to whatever
      // `ollama list` returned first, and the "Describe images" default to a
      // capability probe of a missing model, i.e. off. Clear it so the two
      // agree; the appliance default then applies. Only when the list is
      // non-empty — an empty list is the backend being unreachable, not the
      // model being gone, and must not erase a valid preference.
      // Clearing it is a chat-model switch on the server like any other, so it
      // bumps the revision: after an endpoint change the model-owned settings
      // on screen were loaded for a model the new backend does not serve.
      if (persistedModel != null && !persistedIsServed && data.length > 0) {
        void fetchJson('/api/personalization/chat-model', {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify({ chatModel: null }),
        })
          .then(() => setChatModelRevision((revision) => revision + 1))
          .catch(() => undefined);
      }

      const visionModels = data.filter((m) => m.vision === true);
      const persistedVisionModel = localStorage.getItem(ACTIVE_VISION_MODEL_KEY);
      const visionModel = visionModels.find((m) => m.model === persistedVisionModel)
        ? persistedVisionModel
        : (visionModels[0]?.model ?? null);

      setSelectedVisionModel(visionModel);

      if (visionModel) {
        localStorage.setItem(ACTIVE_VISION_MODEL_KEY, visionModel);
      }
    } catch (error: unknown) {
      setError(error as Error);
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    (async () => {
      if (!ready) {
        return;
      }

      if (initialRequestRef.current === true) {
        return;
      }

      await fetchModels();

      initialRequestRef.current = true;
    })();
  }, [ready, fetchModels]);

  const thinkingSupported = useMemo(
    () => activeModels.find((model) => model.model === selectedModel)?.thinking ?? false,
    [activeModels, selectedModel],
  );

  const toolsSupported = useMemo(
    () => activeModels.find((model) => model.model === selectedModel)?.tools ?? false,
    [activeModels, selectedModel],
  );

  const thinkingEnabled = thinkingPreferred && thinkingSupported;
  const toolsEnabled = toolsPreferred && toolsSupported;

  return [
    {
      selectedModel,
      selectedVisionModel,
      chatModelRevision,
      chatModelSaving: chatModelSaves > 0,
      thinkingSupported,
      thinkingEnabled,
      toolsSupported,
      toolsEnabled,
      activeModels,
      loading,
      error,
    },
    {
      selectModel,
      selectVisionModel,
      toggleThinking,
      toggleTools,
      refetch: fetchModels,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useModel);

export { Provider as ModelProvider, useHookContext as useModel };
