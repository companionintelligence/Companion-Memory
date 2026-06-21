import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createHookContext, fetchJson } from '@ci/common';

import { useAuth } from './useAuth';

const ACTIVE_MODEL_KEY = 'activeModel';
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
  const [{ authToken, expired }] = useAuth();

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedVisionModel, setSelectedVisionModel] = useState<string | null>(null);
  const [activeModels, setActiveModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [toolsPreferred, setToolsPreferred] = useState<boolean>(true);
  const [thinkingPreferred, setThinkingPreferred] = useState<boolean>(true);

  const initialRequestRef = useRef<boolean>(false);

  const selectModel = useCallback(
    (model: string | null) => {
      setSelectedModel(model);

      if (model) {
        localStorage.setItem(ACTIVE_MODEL_KEY, model);
      } else {
        localStorage.removeItem(ACTIVE_MODEL_KEY);
      }

      const selected = activeModels.find((m) => m.model === model);

      if (selected?.vision) {
        setSelectedVisionModel(model);

        if (model) {
          localStorage.setItem(ACTIVE_VISION_MODEL_KEY, model);
        }
      }
    },
    [activeModels],
  );

  const selectVisionModel = useCallback((model: string | null) => {
    setSelectedVisionModel(model);

    if (model) {
      localStorage.setItem(ACTIVE_VISION_MODEL_KEY, model);
    } else {
      localStorage.removeItem(ACTIVE_VISION_MODEL_KEY);
    }
  }, []);

  const toggleThinking = useCallback(() => setThinkingPreferred((current) => !current), []);
  const toggleTools = useCallback(() => setToolsPreferred((current) => !current), []);

  const fetchModels = useCallback(async () => {
    setActiveModels([]);
    setLoading(true);
    setError(null);

    try {
      const data =
        (await fetchJson<Model[]>('/api/llm/models', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
        })) ?? [];

      setActiveModels(data);

      const persistedModel = localStorage.getItem(ACTIVE_MODEL_KEY);
      const model = data.find((m) => m.model === persistedModel) ? persistedModel : (data[0].model ?? null);

      setSelectedModel(model);

      if (model) {
        localStorage.setItem(ACTIVE_MODEL_KEY, model);
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
  }, [authToken]);

  useEffect(() => {
    (async () => {
      if (authToken == null || expired) {
        return;
      }

      if (initialRequestRef.current === true) {
        return;
      }

      await fetchModels();

      initialRequestRef.current = true;
    })();
  }, [authToken, fetchModels, expired]);

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
