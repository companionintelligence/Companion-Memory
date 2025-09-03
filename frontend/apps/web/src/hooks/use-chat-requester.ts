import { useCallback, useEffect, useRef, useState } from 'react';

import type { FormData } from '@/components/Chat';

import { useAuth } from './use-auth';
import { useModel } from './use-model';

type Opts = {
  threadId: string | null;
  onNewThread?: (threadId: string) => void;
  enableTools?: boolean;
  enableThinking?: boolean;
};

type ReturnType = [
  {
    stream: ReadableStream<Uint8Array> | null;
    loading: boolean;
    error: unknown | null;
    streaming: boolean;
  },
  {
    submit: (data: FormData) => Promise<boolean>;
    stop: () => void;
  },
];

export function useChatRequester({
  threadId,
  onNewThread,
  enableTools = true,
  enableThinking = true,
}: Opts): ReturnType {
  const [{ authToken }] = useAuth();
  const [{ selectedModel }] = useModel();

  const abortControllerRef = useRef<AbortController | null>(null);

  const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<unknown | null>(null);
  const [streaming, setStreaming] = useState<boolean>(false);

  const submit = useCallback(
    async (data: FormData) => {
      if (!data.message.trim()) {
        return false;
      }

      abortControllerRef.current?.abort();

      const controller = new AbortController();

      abortControllerRef.current = controller;

      setStream(null);
      setLoading(true);
      setError(null);
      setStreaming(false);

      let success = false;

      try {
        const res = await fetch('/api/llm/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            prompt: data.message.trim(),
            model: selectedModel,
            threadId: threadId,
            enableTools: enableTools,
            enableThinking: enableThinking,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error('Request error');
        }

        if (!res.body) {
          throw new Error('No response body');
        }

        success = true;

        const newThreadId = res.headers.get('X-Thread-Id') as string;

        if (newThreadId && newThreadId !== threadId) {
          onNewThread?.(newThreadId);
        }

        const monitor = new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
          flush(controller) {
            setStreaming(false);
            abortControllerRef.current = null;
            controller.terminate();
          },
        });

        const stream = res.body.pipeThrough(monitor);

        setStream(stream);
        setStreaming(true);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err);
        }
      } finally {
        setLoading(false);
      }

      return success;
    },
    [authToken, selectedModel, threadId, onNewThread, enableTools, enableThinking],
  );

  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    setStream(null);
    setStreaming(false);
  }, []);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return [
    {
      stream,
      loading,
      error,
      streaming,
    },
    {
      submit,
      stop,
    },
  ];
}
