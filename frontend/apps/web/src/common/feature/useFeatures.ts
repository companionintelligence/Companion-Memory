import { useCallback, useEffect, useRef, useState } from 'react';

import { createHookContext, fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

type Features = Record<string, boolean>;

type ReturnValue = {
  isFeatureEnabled: (featureName: string) => boolean;
  refresh: () => Promise<void>;
};

function useFeatures(): ReturnValue {
  const [{ authToken }] = useAuth();

  const [features, setFeatures] = useState<Features>({});
  const [globalFeatures, setGlobalFeatures] = useState<Features>({});

  const hasFetched = useRef(false);
  const hasFetchedGlobal = useRef(false);

  const fetchFeatures = useCallback(
    async (force = false) => {
      if (!authToken) {
        return;
      }

      if (hasFetched.current && !force) {
        return;
      }

      try {
        const data = await fetchJson<Features>('/api/_internal/features', {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });

        if (data) {
          setFeatures(data);
          hasFetched.current = true;
        }
      } catch (err) {
        console.error('Failed to fetch features', err);
      }
    },
    [authToken],
  );

  const fetchGlobalFeatures = useCallback(async (force = false) => {
    if (hasFetchedGlobal.current && !force) {
      return;
    }

    try {
      const data = await fetchJson<Features>('/api/_internal/features/global');

      if (data) {
        setGlobalFeatures(data);
        hasFetchedGlobal.current = true;
      }
    } catch (err) {
      console.error('Failed to fetch features', err);
    }
  }, []);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  useEffect(() => {
    fetchGlobalFeatures();
  }, [fetchGlobalFeatures]);

  const isFeatureEnabled = useCallback(
    (featureName: string) => {
      if (hasFetched.current && features[featureName] === true) {
        return true;
      }

      if (hasFetchedGlobal.current && globalFeatures[featureName] === true) {
        return true;
      }

      return false;
    },
    [features, globalFeatures],
  );

  return {
    isFeatureEnabled,
    refresh: async () => {
      await Promise.allSettled([fetchFeatures(true), fetchGlobalFeatures(true)]);
    },
  };
}

const { Provider, useHookContext } = createHookContext(useFeatures);

export { Provider as FeaturesProvider, useHookContext as useFeatures };
