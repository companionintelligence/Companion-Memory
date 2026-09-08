import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { RefreshCw, Send, Sparkles, X } from '@ci/shadcn/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { v7 as uuid7 } from 'uuid';

import { useThreadService } from '@/api';
import { steerDispatchJob, useDispatchJob } from '@/api/useDispatchJob';
import { Chat, type FormData } from '@/components/Chat';
import { ErrorState } from '@/components/ErrorState';
import { MemoryHubShell } from '@/components/MemoryHub';
import { useAuth, useChatRequester, useCounter, useModel } from '@/hooks';
import { clearAgentChatContext, formatAgentChatDraft, readAgentChatContext } from '@/lib/agentChat';

import { CHAT_BASE, chatThreadPath } from './chatPaths';
import { ChatSidebar } from './ChatSidebar';
import { STARTER_PROMPTS } from './starterPrompts';
import { type Message } from './types';
import { useThreadListService } from './useThreadListService';

function ChatPageContent() {
  const resolvedThreadId = useRef<string | null>(null);
  const hasSetInitialMessages = useRef(false);
  const lastProcessedResponseRef = useRef<string>('');
  const threadTitleRefreshTimeoutRef = useRef<number | null>(null);

  const navigate = useNavigate();

  const { id: initialThreadId } = useParams<{ id?: string }>();
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [{ selectedModel }] = useModel();

  const [
    { threads, loading: threadsLoading, error: threadsError },
    { refetch: refetchThreads, delete: deleteThread },
  ] = useThreadListService();

  const [{ authToken }] = useAuth();
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
    { stream, loading: chatRequestLoading, streaming: chatRequestStreaming, hasStartedReceiving },
    {
      submit: submitChatRequest,
      stop: stopChatRequest,
      attach: attachChatStream,
      detach: detachChatStream,
      cancel: cancelGeneration,
    },
  ] = useChatRequester({
    threadId: resolvedThreadId.current,
    onNewThread: handleNewThread,
  });

  const navigateToChatList = useCallback(() => {
    incrementNewThreadCount();
    detachChatStream();
    resolvedThreadId.current = null;
    navigate(CHAT_BASE);
  }, [incrementNewThreadCount, detachChatStream, navigate]);

  useEffect(() => {
    setInitialMessages([]);
    hasSetInitialMessages.current = initialThreadId ? false : true;
    resolvedThreadId.current = initialThreadId ?? null;
  }, [initialThreadId]);

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
        detachChatStream();
        navigate(chatThreadPath(threadId));
      }
    },
    [navigate, detachChatStream],
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

      if (isDispatch && dispatchJob && authToken) {
        await steerDispatchJob(authToken, dispatchJob.id, {
          action: 'continue',
          message: data.message,
        });
        await refetchThread();

        return true;
      }

      return submitChatRequest(data);
    },
    [authToken, dispatchJob, isDispatch, refetchThread, submitChatRequest],
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
      if (selectedModel == null || chatRequestLoading) {
        return;
      }

      setInitialMessages((prev) => [
        ...prev,
        {
          id: uuid7(),
          model: selectedModel,
          role: 'user',
          content: prompt,
          mimetype: null,
          toolCalls: null,
          canceled: false,
        },
      ]);

      void submitChatRequest({ message: prompt });
    },
    [chatRequestLoading, selectedModel, submitChatRequest],
  );

  const loading = threadsLoading || threadLoading || chatRequestLoading;
  const isSubmitDisabled = selectedModel == null;
  const inputPlaceholder =
    resolvedThreadId.current == null
      ? 'Ask about Memory, Plan, Forecast, Brief…'
      : 'Continue — Memory, Plan, Forecast, Brief…';

  let emptyState: ReactNode;

  if (threadError && initialMessages.length === 0) {
    // A specific thread that failed to LOAD used to satisfy neither branch
    // below — `threadsError` is the thread LIST's error, and
    // `resolvedThreadId.current` is set — so `emptyState` stayed undefined and
    // the page rendered an open conversation with no messages. Deep-linking to
    // /chat/:id while the API is failing therefore looked exactly like a thread
    // whose history had been deleted, and typing into it would start appending
    // to a conversation whose real contents were never shown.
    emptyState = (
      <ErrorState
        title="Could not load this conversation"
        description="Your messages are still here — this device could not reach them just now."
        onRetry={() => void refetchThread()}
      />
    );
  } else if (threadsError) {
    emptyState = (
      <Card className="border-destructive/20 bg-destructive/5">
        <Card.Content className="p-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-destructive/20 flex items-center justify-center flex-shrink-0">
              <X className="h-5 w-5 text-destructive" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-destructive mb-2">Error loading threads</h3>
              <p className="text-sm text-destructive/80 mb-4">{String(threadsError)}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={refetchThreads}
                className="border-destructive/20 text-destructive hover:bg-destructive/10"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Try Again
              </Button>
            </div>
          </div>
        </Card.Content>
      </Card>
    );
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
        <p className="mb-4 text-xs text-gray-400">
          Ask about Memory, Plan to-dos, Forecast, or Brief — or attach a file
        </p>

        <ul aria-label="Suggested asks" className="w-full space-y-1.5 pb-1 text-left">
          {STARTER_PROMPTS.map((prompt) => (
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
          <Chat
            key={initialThreadId ?? `new-thread-${newThreadCount}`}
            loading={loading}
            streaming={chatRequestStreaming}
            hasStartedReceiving={hasStartedReceiving}
            disabled={isSubmitDisabled}
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
