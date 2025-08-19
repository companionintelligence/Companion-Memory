import { useCallback, useEffect, useState } from 'react';

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
    activeModels: Model[];
    loading: boolean;
    error: Error | null;
  },
  {
    selectModel: (model: string | null) => void;
  },
];

function useModel(): Value {
  const [{ authToken }] = useAuth();

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [activeModels, setActiveModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

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

  useEffect(() => {
    (async () => {
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
    })();
  }, [authToken]);

  return [
    {
      selectedModel,
      activeModels,
      loading,
      error,
    },
    {
      selectModel,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useModel);

export { Provider as ModelProvider, useHookContext as useModel };
