import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  FetchJsonError,
  findLocalLlmModel,
  Portal,
  resetLocalLlmConversation,
  useDeviceLayout,
  usePageTitle,
  type LocalLlmGenerationStats,
} from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { Send, Smartphone, Sparkles } from '@ci/shadcn/icons';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { v7 as uuid7 } from 'uuid';

import { useThreadService } from '@/api';
import { useAnswersFromDevice } from '@/api/powersync/deviceFallback';
import { steerDispatchJob, useDispatchJob } from '@/api/useDispatchJob';
import { useFeatures } from '@/common/feature';
import { Chat, type FormData } from '@/components/Chat';
import { ErrorState } from '@/components/ErrorState';
import { MemoryHubShell } from '@/components/MemoryHub';
import { useToolsOffReason } from '@/components/ModelSelector';
import { useAuth, useChatRequester, useCounter, useModel } from '@/hooks';
import { useLocalLlmPrefs } from '@/hooks/useOnDeviceModel';
import { clearAgentChatContext, formatAgentChatDraft, readAgentChatContext } from '@/lib/agentChat';

import { ChatNoModelState } from './ChatNoModelState';
import { CHAT_BASE, chatThreadPath } from './chatPaths';
import { ChatSidebar } from './ChatSidebar';
import { PhoneChatBar } from './PhoneChatBar';
import { TOOL_STARTER_PROMPTS, chatTopicsFor, joinTopics, starterPromptsFor } from './starterPrompts';
import { type Message } from './types';
import { useThreadListService } from './useThreadListService';

/**
 * The server answers 404 for a thread this person no longer has: deleted from this device or another, or never
 * theirs. Nothing the page does later changes that. Every other failure (offline, a timeout, a 5xx) is a failed
 * FETCH of a thread that is still there.
 */
function isThreadGone(error: unknown): boolean {
  return error instanceof FetchJsonError && error.status === 404;
}

/**
 * Says the last reply came from this phone rather than the Companion, and how fast. The speed is the same
 * time-to-first-token / decode-rate pair Google AI Edge Gallery shows under a reply; it is the one honest
 * signal of whether this device is coping with the model it chose.
 *
 * It wraps rather than truncating: time to first token is the last thing on the line, and on a 402pt phone
 * the line ended in an ellipsis just before it.
 */
function OnDeviceBadge({ modelId, stats }: { modelId: string; stats: LocalLlmGenerationStats | null }) {
  const label = findLocalLlmModel(modelId)?.label ?? modelId;

  return (
    <p
      role="status"
      data-testid="on-device-badge"
      className="text-muted-foreground border-border mx-auto mb-2 flex w-full max-w-xl items-start gap-2 rounded-md border px-3 py-1.5 text-xs"
    >
      <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        Answered on this phone · {label}
        {stats
          ? ` · ${stats.decodeTokensPerSecond.toFixed(1)} tok/s${stats.tokensEstimated ? ' (est.)' : ''} · ${(stats.timeToFirstTokenMs / 1000).toFixed(1)}s to first token`
          : ''}
      </span>
    </p>
  );
}

function ChatPageContent() {
  const resolvedThreadId = useRef<string | null>(null);
  const hasSetInitialMessages = useRef(false);
  const lastProcessedResponseRef = useRef<string>('');
  const threadTitleRefreshTimeoutRef = useRef<number | null>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useDeviceLayout();

  const { id: initialThreadId } = useParams<{ id?: string }>();
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [{ selectedModel, loading: modelsLoading, error: modelsError }, { refetch: refetchModels }] =
    useModel();
  const { isFeatureEnabled } = useFeatures();
  const toolsOff = useToolsOffReason() !== null;
  const [localPrefs] = useLocalLlmPrefs();
  // With a phone model chosen and routing on, chat works with no appliance model at all — the case where
  // the appliance is unreachable and `useModel` has nothing to select.
  const localChatEnabled = localPrefs.mode !== 'appliance' && localPrefs.modelId !== null;
  // Photos are read on the phone (never uploaded) only when the phone alone answers and its model can see.
  const localImages =
    localPrefs.mode === 'device' &&
    Boolean(localPrefs.modelId && findLocalLlmModel(localPrefs.modelId)?.capabilities.includes('vision'));
  // The phone alone answers but nothing on it can read a file: attaching could only upload it to the appliance,
  // which "Always answer on this phone" promises never happens.
  const blockUploads = localPrefs.mode === 'device' && !localImages;

  const [
    { threads, loading: threadsLoading, error: threadsError },
    { refetch: refetchThreads, delete: deleteThread },
  ] = useThreadListService();
  // Whether the phone is answering for itself (the Memory server away, a replica on hand).
  const answersFromDevice = useAnswersFromDevice();

  const [{ authToken, authenticated }] = useAuth();
  const [{ thread, loading: threadLoading, error: threadError }, { refetch: refetchThread }] =
    useThreadService(resolvedThreadId.current);
  const isDispatch = thread?.kind === 'dispatch';
  const { job: dispatchJob } = useDispatchJob(thread?.id ?? null, Boolean(isDispatch));

  const [{ count: newThreadCount }, { increment: incrementNewThreadCount }] = useCounter();

  const handleNewThread = useCallback(
    (threadId: string) => {
      resolvedThreadId.current = threadId;
      window.history.replaceState({}, '', chatThreadPath(threadId));
      refetchThreads();
      refetchThread();
    },
    [refetchThreads],
  );

  const [
    { stream, loading: chatRequestLoading, streaming: chatRequestStreaming, hasStartedReceiving, local },
    {
      submit: submitChatRequest,
      stop: stopChatRequest,
      attach: attachChatStream,
      detach: detachChatStream,
      reset: resetChatStream,
      cancel: cancelGeneration,
    },
  ] = useChatRequester({
    threadId: resolvedThreadId.current,
    onNewThread: handleNewThread,
  });

  /**
   * Back to an empty chat. A new chat must not inherit the previous one's turns — the native conversation keeps
   * them — or its stream, or the "answered on this phone" badge, or the starter ask that was echoed into the
   * message list, or the draft "Chat about this" seeded the composer with.
   */
  const startNewChat = useCallback(() => {
    incrementNewThreadCount();
    resetChatStream();
    void resetLocalLlmConversation();
    resolvedThreadId.current = null;
    setInitialMessages([]);
    setChatDraft('');
  }, [incrementNewThreadCount, resetChatStream]);

  const navigateToChatList = useCallback(() => {
    startNewChat();
    navigate(CHAT_BASE);
  }, [startNewChat, navigate]);

  useEffect(() => {
    setInitialMessages([]);
    hasSetInitialMessages.current = initialThreadId ? false : true;
    resolvedThreadId.current = initialThreadId ?? null;
  }, [initialThreadId]);

  // The sidebar's `onSelectThread` resets the conversation it is leaving, but the phone drawer's thread rows (and
  // the browser's back button) are plain router navigations that never pass through it — so the route change
  // itself has to say the conversation changed. Skipped on mount: nothing has been left yet.
  const routedThreadId = useRef(initialThreadId);

  useEffect(() => {
    if (routedThreadId.current === initialThreadId) {
      return;
    }

    routedThreadId.current = initialThreadId;
    resetChatStream();
    void resetLocalLlmConversation();
    // Declared before the seeding effect below, so a fresh "Chat about this" seed still lands after this clears.
    setChatDraft('');
  }, [initialThreadId, resetChatStream]);

  // The first message of a new chat moves the address bar to its thread without telling the router (see
  // `handleNewThread`), so the router still believes it is on the bare chat path. A link to that path — the Chat
  // row in the phone drawer, the Chat tab on every Memory page — then lands "where it already is", and the chat
  // kept its conversation. A fresh navigation to the bare path with something to start over from has to mean a
  // new chat: a thread, or an on-device turn (which never has one — the badge is what says it happened). Declared
  // after the effect above: when the route itself dropped the thread, that one has already cleared it.
  const seenLocationKey = useRef(location.key);

  useEffect(() => {
    if (seenLocationKey.current === location.key) {
      return;
    }

    seenLocationKey.current = location.key;

    if (!initialThreadId && (resolvedThreadId.current != null || local != null)) {
      startNewChat();
    }
  }, [location.key, initialThreadId, local, startNewChat]);

  useEffect(() => {
    if (initialThreadId) {
      return;
    }

    const seed = readAgentChatContext();

    if (!seed) {
      return;
    }

    clearAgentChatContext();
    setChatDraft(formatAgentChatDraft(seed));
  }, [initialThreadId]);

  useEffect(() => {
    if (thread && !hasSetInitialMessages.current) {
      const generating =
        thread.kind !== 'dispatch' &&
        (thread.generationStatus === 'queued' || thread.generationStatus === 'running');
      const loaded = thread.messages ?? [];
      const last = loaded[loaded.length - 1];
      const messages = generating && last?.role === 'assistant' ? loaded.slice(0, -1) : loaded;

      setInitialMessages(messages);
      hasSetInitialMessages.current = true;

      if (generating && thread.id) {
        void attachChatStream(thread.id).then((attached) => {
          if (!attached) {
            setInitialMessages(loaded);
          }
        });
      }
    }
  }, [thread, attachChatStream]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      if (resolvedThreadId.current !== threadId) {
        resetChatStream();
        void resetLocalLlmConversation();
        navigate(chatThreadPath(threadId));
      }
    },
    [navigate, resetChatStream],
  );

  const handleDeleteThread = useCallback(
    (threadId: string) => {
      cancelGeneration(threadId);
      deleteThread(threadId);

      if (resolvedThreadId.current === threadId) {
        navigateToChatList();
      }
    },
    [cancelGeneration, deleteThread, navigateToChatList],
  );

  useEffect(() => {
    if (!isDispatch || !thread?.messages) {
      return;
    }

    setInitialMessages(thread.messages);
  }, [isDispatch, thread?.messages]);

  useEffect(() => {
    if (!isDispatch || !thread?.id) {
      return;
    }

    const timer = window.setInterval(() => {
      void refetchThread({ silent: true });
    }, 4000);

    return () => window.clearInterval(timer);
  }, [isDispatch, refetchThread, thread?.id]);

  const handleSubmit = useCallback(
    async (data: FormData, e?: FormEvent) => {
      e?.preventDefault();

      // `authenticated`, not `authToken`: the token is the web JWT, which the native shell never has.
      if (isDispatch && dispatchJob && authenticated) {
        await steerDispatchJob(authToken ?? null, dispatchJob.id, {
          action: 'continue',
          message: data.message,
        });
        await refetchThread();

        return true;
      }

      return submitChatRequest(data);
    },
    [authToken, authenticated, dispatchJob, isDispatch, refetchThread, submitChatRequest],
  );

  useEffect(() => {
    return () => {
      if (threadTitleRefreshTimeoutRef.current != null) {
        window.clearTimeout(threadTitleRefreshTimeoutRef.current);
      }
    };
  }, []);

  const handleResponseFinished = useCallback(
    (text: string) => {
      if (text.trim() && text !== lastProcessedResponseRef.current) {
        lastProcessedResponseRef.current = text;
      }

      refetchThreads();
      if (threadTitleRefreshTimeoutRef.current != null) {
        window.clearTimeout(threadTitleRefreshTimeoutRef.current);
      }

      threadTitleRefreshTimeoutRef.current = window.setTimeout(() => {
        refetchThreads();
      }, 5000);
    },
    [refetchThreads],
  );

  /**
   * Tapping a starter ask has to *send* it, not just prefill the composer. The
   * composer's own submit path lives inside `Chat` and is not reachable from
   * here, so we echo the user turn into `messages` ourselves — that both shows
   * the bubble and flips `Chat` out of its empty state — and then fire the same
   * request the composer would have.
   */
  const handleStarterPrompt = useCallback(
    (prompt: string) => {
      if ((selectedModel == null && !localChatEnabled) || chatRequestLoading) {
        return;
      }

      setInitialMessages((prev) => [
        ...prev,
        {
          id: uuid7(),
          model: selectedModel ?? localPrefs.modelId ?? '',
          role: 'user',
          content: prompt,
          mimetype: null,
          toolCalls: null,
          canceled: false,
        },
      ]);

      void submitChatRequest({ message: prompt });
    },
    [chatRequestLoading, localChatEnabled, localPrefs.modelId, selectedModel, submitChatRequest],
  );

  const loading = threadsLoading || threadLoading || chatRequestLoading;
  const isSubmitDisabled = selectedModel == null && !localChatEnabled;
  // Still fetching is not "no model": the list arrives a beat after the page, and
  // flashing a setup prompt at someone whose model is about to appear is worth
  // less than the blank it replaces. A phone model that answers is a model too.
  const hasNoModel = selectedModel == null && !modelsLoading && !localChatEnabled;
  const topics = joinTopics(chatTopicsFor(isFeatureEnabled), 'or');
  const inputPlaceholder = hasNoModel
    ? 'Chat is off until a model is set up — Settings → Model'
    : resolvedThreadId.current == null
      ? `Ask about ${topics}…`
      : `Continue — ${topics}…`;

  // With no tools, only the starters the snapshots can answer: a tool-only one
  // would be answered with an invented place or a literal tool call.
  const enabledStarters = starterPromptsFor(isFeatureEnabled);
  const starterPrompts = toolsOff
    ? enabledStarters.filter((prompt) => !TOOL_STARTER_PROMPTS.has(prompt))
    : enabledStarters;

  // Nothing can be sent into a thread the server no longer has: the reply would only 404 and the message be lost.
  const threadGone = initialMessages.length === 0 && isThreadGone(threadError);

  let emptyState: ReactNode;

  if (threadError && initialMessages.length === 0) {
    // A specific thread that failed to LOAD used to satisfy neither branch
    // below — `threadsError` is the thread LIST's error, and
    // `resolvedThreadId.current` is set — so `emptyState` stayed undefined and
    // the page rendered an open conversation with no messages. Deep-linking to
    // /chat/:id while the API is failing therefore looked exactly like a thread
    // whose history had been deleted, and typing into it would start appending
    // to a conversation whose real contents were never shown.
    //
    // A thread the server no longer has is the one failure where "your messages are still here" is false and Try
    // again can only fail again, so it says so and offers the way back instead.
    emptyState = threadGone ? (
      <ErrorState
        title="This chat was deleted."
        description="It is no longer on your Companion, so there is nothing left to open. Start a new chat to carry on."
      >
        <Button size="sm" onClick={navigateToChatList}>
          New chat
        </Button>
      </ErrorState>
    ) : (
      <ErrorState
        title="Could not load this conversation"
        description="Your messages are still here — this device could not reach them just now."
        onRetry={() => void refetchThread()}
      />
    );
  } else if (threadsError) {
    // The shared error state, not the raw error: on a phone whose Memory server is away
    // this used to print "Fetch failed: 500 Internal Server Error" (the dev proxy's answer
    // for a server that is down) under "Error loading threads", which reads as a bug in
    // the app. Offline it is a notice, not an error: chat still works on the phone's own
    // model, and a red triangle under "Needs the Memory server" read as if it did not.
    // Online, the caller's words below apply.
    emptyState = answersFromDevice ? (
      <ErrorState
        tone="notice"
        title="Local chat only"
        description="The Memory server is not answering, so your past chats cannot be shown. A new chat can still run on this phone's own model."
        onRetry={refetchThreads}
      />
    ) : (
      <ErrorState
        title="Could not load your chats"
        description="Your chats are still on your Companion — this device could not reach them just now."
        onRetry={refetchThreads}
      />
    );
  } else if (resolvedThreadId.current == null && hasNoModel) {
    emptyState = <ChatNoModelState unreachable={modelsError != null} onRetry={refetchModels} />;
  } else if (resolvedThreadId.current == null) {
    emptyState = (
      // The ten starters overflow a phone viewport, so this column scrolls on
      // its own rather than pushing the composer off screen. `min-h-0` lets it
      // shrink below its content height inside Chat's centred flex column.
      <div className="flex min-h-0 w-full max-w-xl flex-col items-center overflow-y-auto px-2 text-gray-500">
        <div className="mb-4 mx-auto flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-stone-100">
          <Send className="relative -left-0.5 top-0.5 h-8 w-8 text-zinc-400" />
        </div>
        <p className="mb-1 text-sm">Start a conversation with your Companion</p>
        <p className="mb-4 text-xs text-gray-400">Ask about {topics} — or attach a file</p>

        <ul aria-label="Suggested asks" className="w-full space-y-1.5 pb-1 text-left">
          {starterPrompts.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                disabled={isSubmitDisabled}
                onClick={() => handleStarterPrompt(prompt)}
                className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-left text-[13px] text-foreground hover:border-primary/50 hover:bg-muted/50 disabled:opacity-60"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                <span className="min-w-0 flex-1">{prompt}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    // Plain flex-col at h-full, not PageContent — Chat manages its own
    // internal scrolling (message list scrolls, the composer stays pinned),
    // and PageContent's own `overflow-auto` would add a second, unwanted
    // scroll container around the whole page. `flex-col` alone is enough for
    // MemoryHubShell's `fillHeight` to participate in the flex layout below.
    <div className="flex h-full flex-col">
      <MemoryHubShell fillHeight>
        <Portal.Slot id="tertiary-navigation">
          <ChatSidebar
            threads={threads}
            loading={loading}
            selectedThreadId={resolvedThreadId.current}
            onSelectThread={handleSelectThread}
            onNewThread={navigateToChatList}
            onDeleteThread={handleDeleteThread}
            onRefresh={refetchThreads}
          />
        </Portal.Slot>

        <div className="flex min-h-0 flex-1 flex-col">
          {isMobile ? (
            <PhoneChatBar
              threads={threads}
              loading={threadsLoading}
              selectedThreadId={resolvedThreadId.current}
              onSelectThread={handleSelectThread}
              onNewThread={navigateToChatList}
              onDeleteThread={handleDeleteThread}
              onRefresh={refetchThreads}
            />
          ) : null}
          {local ? <OnDeviceBadge modelId={local.modelId} stats={local.stats} /> : null}
          <Chat
            key={initialThreadId ?? `new-thread-${newThreadCount}`}
            loading={loading}
            streaming={chatRequestStreaming}
            hasStartedReceiving={hasStartedReceiving}
            disabled={isSubmitDisabled || threadGone}
            localImages={localImages}
            blockUploads={blockUploads}
            placeholder={inputPlaceholder}
            initialDraft={chatDraft}
            messages={initialMessages}
            emptyState={emptyState}
            readable={isDispatch ? undefined : (stream ?? undefined)}
            onSubmit={handleSubmit}
            onStop={stopChatRequest}
            autoFocus={true}
            onResponseFinished={handleResponseFinished}
            onStreamError={detachChatStream}
          >
            {dispatchJob &&
            (dispatchJob.status === 'queued' ||
              dispatchJob.status === 'running' ||
              dispatchJob.status === 'completed' ||
              dispatchJob.status === 'blocked') ? (
              <Card className="mx-auto mb-3 w-full max-w-xl border-border/80">
                <Card.Content className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span>
                    {dispatchJob.status === 'completed'
                      ? `OpenClaw finished “${dispatchJob.packet?.source?.title ?? thread?.name ?? 'this'}”.`
                      : dispatchJob.status === 'blocked'
                        ? 'OpenClaw stopped and needs you.'
                        : dispatchJob.status === 'running'
                          ? 'OpenClaw is working this. You can leave. Replies land here.'
                          : 'OpenClaw has this. You can leave. Replies land here when it checks in.'}
                  </span>
                  {dispatchJob.taskId ? (
                    <Button variant="outline" size="sm" onClick={() => navigate('/memory/plan')}>
                      Open task
                    </Button>
                  ) : null}
                </Card.Content>
              </Card>
            ) : null}
          </Chat>
        </div>
      </MemoryHubShell>
    </div>
  );
}

export default function ChatPage() {
  usePageTitle('Chat - Companion Memory');

  return <ChatPageContent />;
}
