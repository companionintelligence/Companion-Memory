import { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '@ci/shadcn';

import type { FormData } from '@/components/Chat';

import { useAuth } from './useAuth';
import { useModel } from './useModel';

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
    stop: () => void;
  },
];

export function useChatRequester({ threadId, onNewThread }: Opts): ReturnType {
  const [{ authToken }] = useAuth();
  const [{ selectedModel, thinkingEnabled, toolsEnabled, activeModels }] = useModel();
  const { toast } = useToast();

  const abortControllerRef = useRef<AbortController | null>(null);

  const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<unknown | null>(null);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [hasStartedReceiving, setHasStartedReceiving] = useState<boolean | null>(null);

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

      abortControllerRef.current?.abort();

      const controller = new AbortController();

      abortControllerRef.current = controller;

      setStream(null);
      setLoading(true);
      setError(null);
      setStreaming(false);
      setHasStartedReceiving(false); // Reset on new submission

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
            enableTools: toolsEnabled,
            enableThinking: thinkingEnabled,
            fileIds: data.fileIds,
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

        let hasSeenFirstChunk = false;

        const monitor = new TransformStream({
          transform(chunk, controller) {
            if (!hasSeenFirstChunk) {
              hasSeenFirstChunk = true;
              setHasStartedReceiving(true);
            }

            controller.enqueue(chunk);
          },
          flush(controller) {
            setStreaming(false);
            setHasStartedReceiving(null);
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
    [activeModels, authToken, selectedModel, threadId, onNewThread, toolsEnabled, thinkingEnabled, toast],
  );

  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    setStream(null);
    setStreaming(false);
    setHasStartedReceiving(null);
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
      hasStartedReceiving,
    },
    {
      submit,
      stop,
    },
  ];
}
