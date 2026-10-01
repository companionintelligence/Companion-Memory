import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  cancelLocalLlmDownload,
  deleteLocalLlmModel,
  downloadLocalLlmModel,
  ensureLocalLlmLoaded,
  getLocalLlmPrefs,
  onLocalLlmDownloadProgress,
  probeLocalLlm,
  setLocalLlmPrefs,
  subscribeLocalLlmPrefs,
  unloadLocalLlm,
  type LocalLlmDownloadProgress,
  type LocalLlmPrefs,
  type LocalLlmProbe,
} from '@ci/common';

/** The persisted on-device routing preferences, live across every component that reads them. */
export function useLocalLlmPrefs(): [LocalLlmPrefs, (patch: Partial<LocalLlmPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribeLocalLlmPrefs, getLocalLlmPrefs, getLocalLlmPrefs);
  const update = useCallback((patch: Partial<LocalLlmPrefs>) => {
    setLocalLlmPrefs(patch);
  }, []);

  return [prefs, update];
}

export interface OnDeviceModelState {
  /** `null` until the first probe resolves. */
  probe: LocalLlmProbe | null;
  /** Live download progress by model id, for models currently downloading. */
  progress: Record<string, LocalLlmDownloadProgress>;
  /** The model a load/unload/delete is running on, so its row can show a spinner. */
  busyModelId: string | null;
  error: string | null;
}

export interface OnDeviceModelActions {
  refresh: () => Promise<void>;
  download: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  remove: (modelId: string) => Promise<void>;
  /** Load `modelId` (downloading nothing) and make it the model chat uses. */
  use: (modelId: string) => Promise<void>;
  unload: () => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong with the on-device model.';
}

/**
 * The state and actions behind Settings → On-device model: what this device can run, which models are
 * on disk, download progress, and which one is loaded. Every action re-probes afterwards rather than
 * patching local state, because the native side is the only source of truth for what is on disk.
 */
export function useOnDeviceModel(): [OnDeviceModelState, OnDeviceModelActions] {
  const [probe, setProbe] = useState<LocalLlmProbe | null>(null);
  const [progress, setProgress] = useState<Record<string, LocalLlmDownloadProgress>>({});
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const next = await probeLocalLlm();

    if (mounted.current) {
      setProbe(next);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const unsubscribe = onLocalLlmDownloadProgress((event) => {
      if (!mounted.current) {
        return;
      }

      if (event.status === 'downloading') {
        setProgress((current) => ({ ...current, [event.modelId]: event }));

        return;
      }

      // A terminal state (ready / error / cancelled): drop the live row and re-read the truth.
      setProgress((current) => {
        const { [event.modelId]: _finished, ...rest } = current;

        return rest;
      });

      if (event.status === 'error' && event.error) {
        setError(event.error);
      }

      void refresh();
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refresh]);

  /** Run `work`, surfacing a failure as `error` and always re-probing afterwards. */
  const run = useCallback(
    async (modelId: string | null, work: () => Promise<unknown>) => {
      setError(null);
      setBusyModelId(modelId);

      try {
        await work();
      } catch (err) {
        if (mounted.current) {
          setError(messageOf(err));
        }
      } finally {
        if (mounted.current) {
          setBusyModelId(null);
        }

        await refresh();
      }
    },
    [refresh],
  );

  const download = useCallback(
    (modelId: string) => run(modelId, () => downloadLocalLlmModel(modelId)),
    [run],
  );

  const cancelDownload = useCallback(
    (modelId: string) => run(modelId, () => cancelLocalLlmDownload(modelId)),
    [run],
  );

  const remove = useCallback(
    (modelId: string) =>
      run(modelId, async () => {
        await deleteLocalLlmModel(modelId);

        // Deleting the model chat was pointed at leaves the preference dangling; clear it and stop
        // routing to a model that no longer exists rather than failing on the next message.
        if (getLocalLlmPrefs().modelId === modelId) {
          setLocalLlmPrefs({ modelId: null, mode: 'appliance' });
        }
      }),
    [run],
  );

  const use = useCallback(
    (modelId: string) =>
      run(modelId, async () => {
        const prefs = getLocalLlmPrefs();

        await ensureLocalLlmLoaded(modelId, {
          accelerator: prefs.accelerator ?? undefined,
          enableSpeculativeDecoding: prefs.speculativeDecoding,
          useIntentTools: prefs.intentTools,
        });
        setLocalLlmPrefs({ modelId });
      }),
    [run],
  );

  const unload = useCallback(() => run(null, () => unloadLocalLlm()), [run]);

  return [
    { probe, progress, busyModelId, error },
    { refresh, download, cancelDownload, remove, use, unload },
  ];
}
