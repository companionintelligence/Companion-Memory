import { useCallback, useEffect, useRef, useState } from 'react';

import {
  apiKeyHeaders,
  LOCAL_TOOLS_OFF_REFUSAL,
  ensureLocalLlmLoaded,
  findLocalLlmModel,
  getLocalLlmPrefs,
  isAnswerCutShort,
  isLocalWriteRequest,
  isContextExhausted,
  isLocalLlmReady,
  resetLocalLlmConversation,
  streamLocalLlm,
  streamingFetch,
  type LocalLlmGenerationStats,
} from '@ci/common';
import { useToast } from '@ci/shadcn';

import type { FormData } from '@/components/Chat';
import { Channel, FrameDecoder, FrameEncoder } from '@/components/Chat/utils';

import { useModel } from './useModel';
import { useSessionAuth } from './useSessionAuth';

type Opts = {
  threadId: string | null;
  onNewThread?: (threadId: string) => void;
  /**
   * The action this conversation is about (the Today action window). Sent only
   * with a turn that starts a new thread, so the server can open the thread
   * with the action and link the action to it.
   */
  actionId?: string | null;
};

type ReturnType = [
  {
    stream: ReadableStream<Uint8Array> | null;
    loading: boolean;
    error: unknown | null;
    streaming: boolean;
    hasStartedReceiving: boolean | null;
    /** Set once a turn has been answered by the on-device model; cleared when the appliance answers. */
    local: LocalTurnInfo | null;
  },
  {
    submit: (data: FormData) => Promise<boolean>;
    attach: (threadId: string) => Promise<boolean>;
    detach: () => void;
    /**
     * Leave the conversation on screen (a new chat, another thread): drop its stream like `detach`, and the
     * "answered on this phone" badge too, which describes a turn that is no longer showing. `detach` alone keeps
     * the badge — it is also what Stop calls, and a stopped reply still came from the phone.
     */
    reset: () => void;
    stop: () => void;
    cancel: (id: string) => void;
  },
];

export interface LocalTurnInfo {
  modelId: string;
  /** Decode speed for the last completed turn. Absent while it is still streaming or after a cancel. */
  stats: LocalLlmGenerationStats | null;
}

/**
 * The appliance answered `/api/llm/generate` with a non-2xx status — it was reached and said no. Kept
 * distinct from a transport failure so `auto` mode never mistakes a refusal (a 401 after a key was
 * revoked, a 500 from a broken model) for "offline" and quietly answers from a weaker model instead.
 */
export class ApplianceRefusedError extends Error {
  constructor(message = 'Request error') {
    super(message);
    this.name = 'ApplianceRefusedError';
  }
}

/**
 * Whether a failed appliance request means "cannot reach it" — the only failure an `auto`-mode fall-back
 * answers for.
 *
 * `streamingFetch` returns a `Response` for every HTTP status, so anything it *throws* never got an answer at
 * all — but what it throws differs by shell: a browser `TypeError('Failed to fetch')`, or, in the native apps
 * (where it falls back to CapacitorHttp when the webview fetch fails), a plugin rejection that is often not an
 * `Error` at all ("Unable to resolve host", "The Internet connection appears to be offline"). So a thrown value
 * counts as unreachable unless it is a cancel or the appliance's own refusal; of the *responses*, only the
 * gateway-down statuses do.
 */
export function isApplianceUnreachable(failure: unknown): boolean {
  if (failure instanceof Response) {
    return failure.status === 502 || failure.status === 503 || failure.status === 504;
  }

  if (failure instanceof ApplianceRefusedError) {
    return false;
  }

  const name = (failure as { name?: unknown } | null)?.name;

  return name !== 'AbortError';
}

function pipeMonitor(
  body: ReadableStream<Uint8Array>,
  onFirstChunk: () => void,
  onFlush: () => void,
): ReadableStream<Uint8Array> {
  let hasSeenFirstChunk = false;
  // The server sends keep-alive frames (Channel.KEEPALIVE) from the moment the turn starts, so the
  // body's first bytes are not the reply's. Counting them hid the "working" dots at once and left
  // the page blank until the model spoke. Frames are decoded only until one on another channel
  // arrives.
  const decoder = new FrameDecoder();

  const monitor = new TransformStream({
    transform(chunk, controller) {
      if (!hasSeenFirstChunk && decoder.push(chunk).some((frame) => frame.channel !== Channel.KEEPALIVE)) {
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

export function useChatRequester({ threadId, onNewThread, actionId }: Opts): ReturnType {
  const { headers: sessionHeaders } = useSessionAuth();
  const [{ selectedModel, thinkingEnabled, toolsEnabled, activeModels }] = useModel();
  const { toast } = useToast();

  const abortControllerRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const actionIdRef = useRef(actionId);
  actionIdRef.current = actionId;
  const activeThreadIdRef = useRef<string | null>(threadId);
  if (threadId) {
    activeThreadIdRef.current = threadId;
  }

  const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<unknown | null>(null);
  const [streaming, setStreaming] = useState<boolean>(false);
  const [hasStartedReceiving, setHasStartedReceiving] = useState<boolean | null>(null);
  const [local, setLocal] = useState<LocalTurnInfo | null>(null);

  const detach = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStream(null);
    setStreaming(false);
    setHasStartedReceiving(null);
    setLoading(false);
  }, []);

  const reset = useCallback(() => {
    detach();
    setLocal(null);
    // No thread is active any more. Left set, Stop in the next chat — an on-device turn has no thread of its own to
    // overwrite it — would cancel the server job of the one that was left. A thread the page opens next sets it again.
    activeThreadIdRef.current = null;
  }, [detach]);

  const openBody = useCallback((body: ReadableStream<Uint8Array>) => {
    const monitored = pipeMonitor(
      body,
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

  const openStream = useCallback(
    (res: Response) => {
      if (!res.body) {
        throw new Error('No response body');
      }

      openBody(res.body);
    },
    [openBody],
  );

  /**
   * Answer `prompt` on this device and feed the tokens to the chat as the same length-prefixed frames the
   * appliance streams (`FrameEncoder`), so `Chat` renders a local turn with no special case: answer text on
   * the TEXT channel, reasoning on the THINK channel. Loading a cold model takes seconds, which is why it is
   * awaited here — while `loading` is still true and the chat shows its pending state — and not inside the
   * stream. Resolves `false` (and sets `error`) when the model cannot be loaded.
   */
  const answerOnDevice = useCallback(
    async (prompt: string, controller: AbortController, images?: string[]): Promise<boolean> => {
      const prefs = getLocalLlmPrefs();
      const spec = prefs.modelId ? findLocalLlmModel(prefs.modelId) : undefined;

      if (!prefs.modelId || !spec) {
        const missing = new Error('Choose an on-device model in Settings first.');

        setError(missing);
        toast.error(missing.message);

        return false;
      }

      // Only the tool count is read from the load; `undefined` means "not known this session".
      let loaded: { toolCount?: number };

      try {
        loaded = await ensureLocalLlmLoaded(prefs.modelId, {
          accelerator: prefs.accelerator ?? undefined,
          enableSpeculativeDecoding: prefs.speculativeDecoding,
          useIntentTools: prefs.intentTools,
        });
      } catch (err) {
        setError(err);
        // A refused send leaves no bubble in the transcript (see `Chat`), so it has to say why.
        toast.error(
          err instanceof Error && err.message ? err.message : 'The on-device model could not start.',
        );

        return false;
      }

      // A cold model takes seconds to load. If the chat was left in the meantime (`reset`/`detach` aborted this
      // turn), nobody is waiting for it: generating now would paint a reply and a badge into whatever chat is open.
      if (controller.signal.aborted) {
        return false;
      }

      const encoder = new FrameEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
        },
      });

      // The reader may already be gone (the user hit Stop); a late token then has nowhere to go.
      const push = (channel: Channel, text: string) => {
        try {
          streamController.enqueue(encoder.encodeFrame(channel, text));
        } catch {
          /* stream closed */
        }
      };

      setLocal({ modelId: prefs.modelId, stats: null });

      // A model with no tools cannot add, save, forget or delete anything, and a small one will say it did
      // anyway. The appliance refuses these in code before the model sees them; so does this. An unknown
      // tool count (a model resident from before this session) is not "no tools".
      if (loaded.toolCount === 0 && isLocalWriteRequest(prompt)) {
        push(Channel.TEXT, LOCAL_TOOLS_OFF_REFUSAL);
        streamController.close();
        openBody(body);

        return true;
      }

      const generate = () =>
        streamLocalLlm(prompt, {
          enableThinking: prefs.thinking && spec.capabilities.includes('thinking'),
          images,
          signal: controller.signal,
          onText: (text) => push(Channel.TEXT, text),
          onThought: (thought) => push(Channel.THINK, thought),
        });

      void generate()
        .then(async (first) => {
          // A conversation whose context window is full answers every message with nothing. Say so, start a
          // fresh one (the earlier turns are gone from the model's memory, not from the screen), and ask again
          // — once, so a model that answers nothing for another reason cannot loop.
          if (!controller.signal.aborted && isContextExhausted(first)) {
            toast.info(
              'This chat outgrew the on-device model’s memory — continuing in a fresh conversation.',
            );
            await resetLocalLlmConversation();

            return generate();
          }

          return first;
        })
        .then((result) => {
          if (result.stats) {
            setLocal({ modelId: prefs.modelId as string, stats: result.stats });
          }

          // Not the user's Stop, yet no stats: the device cut the turn short (a thermal cutoff), so the reply
          // on screen is truncated and would otherwise read as complete.
          if (result.cancelled && !controller.signal.aborted) {
            toast.info('The reply stopped early — this phone is running too hot to keep going.');
          }

          // Reasoning that filled the window: tokens were produced, no answer arrived, nothing failed.
          if (!controller.signal.aborted && isAnswerCutShort(result)) {
            toast.info(
              'The on-device model ran out of room before it could answer. Try a shorter question, or turn off "Think before answering" in Settings → On-device model.',
            );
          }

          streamController.close();
        })
        .catch((err: unknown) => {
          try {
            streamController.error(err);
          } catch {
            /* already closed */
          }
        });

      openBody(body);

      return true;
    },
    [openBody, toast],
  );

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

  /** A whole turn on this device, from a cold start: own abort controller, own loading flag. */
  const runLocalTurn = useCallback(
    async (prompt: string, images?: string[]): Promise<boolean> => {
      detach();

      const controller = new AbortController();
      abortControllerRef.current = controller;

      setLoading(true);
      setError(null);
      setStreaming(false);
      setHasStartedReceiving(false);

      try {
        return await answerOnDevice(prompt, controller, images);
      } finally {
        setLoading(false);
      }
    },
    [answerOnDevice, detach],
  );

  /**
   * `auto` mode's second half: the appliance could not be reached, so answer here. Called from inside
   * `submit`'s own try, so it reuses that turn's controller and loading state instead of restarting them.
   *
   * A turn that carried files, or photos this model cannot see, is refused. Answering the text alone would
   * read as if those attachments had been looked at.
   */
  const fallBackToDevice = useCallback(
    async (
      prompt: string,
      controller: AbortController,
      extras?: { fileIds?: string[]; images?: string[] },
    ): Promise<boolean> => {
      if (extras?.fileIds && extras.fileIds.length > 0) {
        toast.error('Your Companion is unreachable, and attachments cannot be read on this phone.');

        return false;
      }

      const images = extras?.images;

      if (images && images.length > 0) {
        const modelId = getLocalLlmPrefs().modelId;
        const spec = modelId ? findLocalLlmModel(modelId) : undefined;

        if (!spec?.capabilities.includes('vision')) {
          toast.error(
            `Your Companion is unreachable, and ${spec?.label ?? 'this model'} cannot read photos.`,
          );

          return false;
        }
      }

      toast.info('Your Companion is unreachable — answering on this phone.');

      return answerOnDevice(prompt, controller, images);
    },
    [answerOnDevice, toast],
  );

  const submit = useCallback(
    async (data: FormData) => {
      if (!data.message.trim()) {
        return false;
      }

      const prompt = data.message.trim();
      const prefs = getLocalLlmPrefs();
      const localReady = prefs.mode !== 'appliance' && (await isLocalLlmReady(prefs.modelId));

      if (prefs.mode === 'device') {
        // "Always on this phone" is a promise nothing leaves the device; never quietly break it by
        // falling through to the appliance when the model is missing.
        if (!localReady) {
          toast.error('Your on-device model is not downloaded. Open Settings → On-device model.');

          return false;
        }

        if (data.fileIds && data.fileIds.length > 0) {
          toast.error('Attachments need your Companion server. Switch off on-device-only mode to send them.');

          return false;
        }

        if (data.images && data.images.length > 0) {
          const spec = prefs.modelId ? findLocalLlmModel(prefs.modelId) : undefined;

          // Never let a photo silently vanish: a model that cannot see would answer as if none was sent.
          if (!spec?.capabilities.includes('vision')) {
            toast.error(
              `${spec?.label ?? 'This model'} cannot read photos. Choose a Gemma 4 model in Settings.`,
            );

            return false;
          }
        }

        return runLocalTurn(prompt, data.images);
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
            prompt,
            model: selectedModel,
            threadId: threadIdRef.current,
            ...(threadIdRef.current == null && actionIdRef.current ? { actionId: actionIdRef.current } : {}),
            enableTools: toolsEnabled,
            enableThinking: thinkingEnabled,
            fileIds: data.fileIds,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          if (localReady && isApplianceUnreachable(res)) {
            return await fallBackToDevice(prompt, controller, { fileIds: data.fileIds, images: data.images });
          }

          throw new ApplianceRefusedError();
        }

        success = true;
        setLocal(null);

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
          if (localReady && isApplianceUnreachable(err)) {
            return await fallBackToDevice(prompt, controller, { fileIds: data.fileIds, images: data.images });
          }

          setError(err);
          // The raw error stays in `error`; a person is told what happened and what to do about it. A refused send
          // leaves no bubble in the transcript (see `Chat`), so this is the only sign it was even tried.
          toast.error(
            err instanceof ApplianceRefusedError
              ? 'Your Companion could not answer that. Try again.'
              : 'Could not reach your Companion. Check your connection and try again.',
          );
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
      runLocalTurn,
      fallBackToDevice,
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
      local,
    },
    {
      submit,
      attach,
      detach,
      reset,
      stop,
      cancel,
    },
  ];
}
