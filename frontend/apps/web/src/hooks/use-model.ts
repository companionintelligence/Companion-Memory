import { useCallback, useEffect, useRef, useState } from 'react';

import { createHookContext, fetchJson } from '@ci/common';

import { useAuth } from './use-auth';

const ACTIVE_MODEL_KEY = 'activeModel';

interface Model {
  model: string;
  namespace: string | null;
  name: string;
  tag: string | null;
}

type Value = [
  {
    selectedModel: string | null;
    thinkingEnabled: boolean;
    toolsEnabled: boolean;
    activeModels: Model[];
    loading: boolean;
    error: Error | null;
  },
  {
    selectModel: (model: string | null) => void;
    toggleThinking: () => void;
    toggleTools: () => void;
    refetch: () => void;
  },
];

function useModel(): Value {
  const [{ authToken, expired }] = useAuth();

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [activeModels, setActiveModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [toolsEnabled, setToolsEnabled] = useState<boolean>(false);
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(false);

  const initialRequestRef = useRef<boolean>(false);

  const selectModel = useCallback(
    (model: string | null) => {
      setSelectedModel(model);

      if (model) {
        localStorage.setItem(ACTIVE_MODEL_KEY, model);
      } else {
        localStorage.removeItem(ACTIVE_MODEL_KEY);
      }
    },
    [setSelectedModel],
  );

  const toggleThinking = useCallback(() => setThinkingEnabled((current) => !current), []);
  const toggleTools = useCallback(() => setToolsEnabled((current) => !current), []);

  const fetchModels = useCallback(async () => {
    setActiveModels([]);
    setLoading(true);
    setError(null);

    try {
      const data: Model[] = await fetchJson('/api/llm/models', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
      });

      setActiveModels(data);

      const persistedModel = localStorage.getItem(ACTIVE_MODEL_KEY);
      const selectedModel = data.find((model) => model.model === persistedModel)
        ? persistedModel
        : (data[0].model ?? null);

      selectModel(selectedModel);
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

  return [
    {
      selectedModel,
      thinkingEnabled,
      toolsEnabled,
      activeModels,
      loading,
      error,
    },
    {
      selectModel,
      toggleThinking,
      toggleTools,
      refetch: fetchModels,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useModel);

export { Provider as ModelProvider, useHookContext as useModel };
