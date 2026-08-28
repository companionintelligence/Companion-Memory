import { useCallback, useEffect, useRef, useState } from 'react';

import { apiKeyHeaders, streamingFetch } from '@ci/common';
import { useToast } from '@ci/shadcn';

import type { FormData } from '@/components/Chat';

import { useModel } from './useModel';
import { useSessionAuth } from './useSessionAuth';

type Opts = {
  threadId: string | null;
  onNewThread?: (threadId: string) => void;
};

type ReturnType = [
  {
    stream: ReadableStream<Uint8Array> | null;
    loading: boolean;
    error: unknown | null;
    streaming: boolean;
    hasStartedReceiving: boolean | null;
  },
  {
    submit: (data: FormData) => Promise<boolean>;
    attach: (threadId: string) => Promise<boolean>;
    detach: () => void;
    stop: () => void;
    cancel: (id: string) => void;
  },
];

function pipeMonitor(
  body: ReadableStream<Uint8Array>,
  onFirstChunk: () => void,
  onFlush: () => void,
): ReadableStream<Uint8Array> {
  let hasSeenFirstChunk = false;

  const monitor = new TransformStream({
    transform(chunk, controller) {
      if (!hasSeenFirstChunk) {
        hasSeenFirstChunk = true;
        onFirstChunk();
      }

      controller.enqueue(chunk);
    },
    flush(controller) {
      onFlush();
      controller.terminate();
    },
  });

  return body.pipeThrough(monitor);
}

export function useChatRequester({ threadId, onNewThread }: Opts): ReturnType {
  const { headers: sessionHeaders } = useSessionAuth();
  const [{ selectedModel, thinkingEnabled, toolsEnabled, activeModels }] = useModel();
  const { toast } = useToast();

  const abortControllerRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const activeThreadIdRef = useRef<string | null>(threadId);
  if (threadId) {
    activeThreadIdRef.current = threadId;
  }

  const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<unknown | null>(null);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [hasStartedReceiving, setHasStartedReceiving] = useState<boolean | null>(null);

  const detach = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStream(null);
    setStreaming(false);
    setHasStartedReceiving(null);
    setLoading(false);
  }, []);

  const openStream = useCallback((res: Response) => {
    if (!res.body) {
      throw new Error('No response body');
    }

    const monitored = pipeMonitor(
      res.body,
      () => setHasStartedReceiving(true),
      () => {
        setStreaming(false);
        setHasStartedReceiving(null);
        abortControllerRef.current = null;
      },
    );

    setStream(monitored);
    setStreaming(true);
  }, []);

  const attach = useCallback(
    async (id: string) => {
      detach();

      const controller = new AbortController();
      abortControllerRef.current = controller;
      activeThreadIdRef.current = id;
      setError(null);
      setLoading(true);
      setHasStartedReceiving(false);

      try {
        const res = await streamingFetch(`/api/llm/threads/${id}/stream`, {
          headers: {
            ...apiKeyHeaders(),
            ...sessionHeaders,
          },
          signal: controller.signal,
        });

        if (res.status === 204) {
          setLoading(false);
          setHasStartedReceiving(null);

          return false;
        }

        if (!res.ok) {
          throw new Error('Request error');
        }

        openStream(res);

        return true;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err);
        }

        return false;
      } finally {
        setLoading(false);
      }
    },
    [detach, openStream, sessionHeaders],
  );

  const submit = useCallback(
    async (data: FormData) => {
      if (!data.message.trim()) {
        return false;
      }

      const selectedModelConfig = activeModels.find((model) => model.model === selectedModel) ?? null;

      if (toolsEnabled && selectedModelConfig?.tools === false) {
        toast.error('Selected model does not support tools. Disable tools or choose another model.');

        return false;
      }

      if (thinkingEnabled && selectedModelConfig?.thinking === false) {
        toast.error('Selected model does not support thinking. Disable thinking or choose another model.');

        return false;
      }

      detach();

      const controller = new AbortController();
      abortControllerRef.current = controller;

      setLoading(true);
      setError(null);
      setStreaming(false);
      setHasStartedReceiving(false);

      let success = false;

      try {
        // Always the appliance. On-device LocalLLM is a later opt-in once
        // `getModelStatus` reports ready — `isAvailable()` is a RAM floor, not
        // a loaded model, and must not steal traffic from Ollama/vLLM.
        const res = await streamingFetch('/api/llm/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...apiKeyHeaders(),
            ...sessionHeaders,
          },
          body: JSON.stringify({
            prompt: data.message.trim(),
            model: selectedModel,
            threadId: threadIdRef.current,
            enableTools: toolsEnabled,
            enableThinking: thinkingEnabled,
            fileIds: data.fileIds,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error('Request error');
        }

        success = true;

        const newThreadId = res.headers.get('X-Thread-Id');

        if (newThreadId) {
          activeThreadIdRef.current = newThreadId;
        }

        if (newThreadId && newThreadId !== threadIdRef.current) {
          onNewThread?.(newThreadId);
        }

        openStream(res);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err);
        }
      } finally {
        setLoading(false);
      }

      return success;
    },
    [
      activeModels,
      selectedModel,
      onNewThread,
      toolsEnabled,
      thinkingEnabled,
      toast,
      detach,
      openStream,
      sessionHeaders,
    ],
  );

  const cancel = useCallback(
    (id: string) => {
      void streamingFetch(`/api/llm/threads/${id}/cancel`, {
        method: 'POST',
        headers: {
          ...apiKeyHeaders(),
          ...sessionHeaders,
        },
      });
    },
    [sessionHeaders],
  );

  const stop = useCallback(() => {
    const id = activeThreadIdRef.current;

    detach();

    if (!id) {
      return;
    }

    cancel(id);
  }, [cancel, detach]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  return [
    {
      stream,
      loading,
      error,
      streaming,
      hasStartedReceiving,
    },
    {
      submit,
      attach,
      detach,
      stop,
      cancel,
    },
  ];
}
