import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { Portal, useDeviceLayout, usePageTitle } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { Loader2, RefreshCw, Send, Sparkles, X } from '@ci/shadcn/icons';
import { useNavigate, useParams } from 'react-router-dom';

import { useThreadService } from '@/api';
import { usePersonaCompose } from '@/api/usePersonaCompose';
import { Chat, type FormData } from '@/components/Chat';
import { HowYoudDoItCard } from '@/components/HowYoudDoItCard';
import { ModelSelector } from '@/components/ModelSelector';
import { useChatRequester, useCounter, useModel } from '@/hooks';
import { clearAgentChatContext, readAgentChatContext } from '@/lib/agentChat';

import { ChatSidebar } from './ChatSidebar';
import { type Message } from './types';
import { useThreadListService } from './useThreadListService';

function ChatPageContent() {
  const { isMobile } = useDeviceLayout();

  const resolvedThreadId = useRef<string | null>(null);
  const hasSetInitialMessages = useRef(false);
  const lastProcessedResponseRef = useRef<string>('');

  const navigate = useNavigate();

  const { id: initialThreadId } = useParams<{ id?: string }>();
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [{ selectedModel }] = useModel();
  const [personaTask, setPersonaTask] = useState('');
  const [applyingPersona, setApplyingPersona] = useState(false);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const [{ loading: personaLoading, error: personaError, result: personaResult }, { compose, apply, clear }] =
    usePersonaCompose();

  const [
    { threads, loading: threadsLoading, error: threadsError },
    { refetch: refetchThreads, delete: deleteThread },
  ] = useThreadListService();

  const [{ thread, loading: threadLoading }, { refetch: refetchThread }] = useThreadService(
    resolvedThreadId.current,
  );

  const [{ count: newThreadCount }, { increment: incrementNewThreadCount }] = useCounter();

  const handleNewThread = useCallback(
    (threadId: string) => {
      resolvedThreadId.current = threadId;
      window.history.replaceState({}, '', `/chat/${threadId}`);
      refetchThreads();
      refetchThread();
    },
    [refetchThreads],
  );

  const [
    { stream, loading: chatRequestLoading, streaming: chatRequestStreaming, hasStartedReceiving },
    { submit: submitChatRequest, stop: stopChatRequest },
  ] = useChatRequester({
    threadId: resolvedThreadId.current,
    onNewThread: handleNewThread,
  });

  const navigateToChatList = useCallback(() => {
    incrementNewThreadCount();
    stopChatRequest();
    resolvedThreadId.current = null;
    navigate('/chat');
  }, [incrementNewThreadCount]);

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

    const draft = seed.body
      ? `I'd like to talk about "${seed.title}":\n\n${seed.body}`
      : `I'd like to talk about "${seed.title}".`;

    setChatDraft(draft);
  }, [initialThreadId]);

  useEffect(() => {
    if (thread && !hasSetInitialMessages.current) {
      setInitialMessages(thread.messages ?? []);
      hasSetInitialMessages.current = true;
    }
  }, [thread]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      if (resolvedThreadId.current !== threadId) {
        stopChatRequest();
        navigate(`/chat/${threadId}`);
      }
    },
    [navigate],
  );

  const handleDeleteThread = useCallback(
    (threadId: string) => {
      deleteThread(threadId);

      if (resolvedThreadId.current === threadId) {
        navigateToChatList();
      }
    },
    [deleteThread, navigateToChatList],
  );

  const handleSubmit = useCallback(
    async (data: FormData, e?: FormEvent) => {
      e?.preventDefault();

      return submitChatRequest(data);
    },
    [submitChatRequest],
  );

  const handleResponseFinished = useCallback((text: string) => {
    if (text.trim()) {
      // Only process new responses
      if (text !== lastProcessedResponseRef.current) {
        lastProcessedResponseRef.current = text;
      }
    }
  }, []);

  const handlePersonaCompose = useCallback(async () => {
    const trimmed = personaTask.trim();
    if (!trimmed || personaLoading) {
      return;
    }

    setApplyNote(null);
    try {
      await compose(trimmed);
    } catch {
      // error surfaced via personaError
    }
  }, [compose, personaLoading, personaTask]);

  const handlePersonaApply = useCallback(async () => {
    if (!personaResult || applyingPersona) {
      return;
    }

    setApplyingPersona(true);
    setApplyNote(null);
    try {
      const { added } = await apply(personaResult);
      setApplyNote(
        added > 0 ? `Added ${added} ${added === 1 ? 'card' : 'cards'} to Possibilities.` : 'Nothing to add.',
      );
    } catch {
      setApplyNote('Could not add to Possibilities.');
    } finally {
      setApplyingPersona(false);
    }
  }, [apply, applyingPersona, personaResult]);

  const handlePersonaFollowUp = useCallback(
    (question: string) => {
      void submitChatRequest({ message: question });
    },
    [submitChatRequest],
  );

  const loading = threadsLoading || threadLoading || chatRequestLoading;
  const isSubmitDisabled = selectedModel == null;
  const inputPlaceholder =
    resolvedThreadId.current == null ? 'Start a new conversation...' : 'Continue the conversation...';

  let emptyState: ReactNode;

  if (threadsError) {
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
      <div className="flex w-full max-w-xl flex-col items-center px-4 text-gray-500">
        <div className="mb-4 mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-stone-100">
          <Send className="relative -left-0.5 top-0.5 h-8 w-8 text-zinc-400" />
        </div>
        <p className="mb-1 text-sm">Start a conversation with your Companion</p>
        <p className="mb-6 text-xs text-gray-400">Ask questions, get recommendations, or explore ideas</p>

        <div className="w-full rounded-xl border border-border bg-background p-3 text-left">
          <p className="mb-2 text-xs font-medium text-foreground">How you’d do it</p>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Paste a task — Companion synthesizes who you are, then suggests your approach.
          </p>
          <textarea
            value={personaTask}
            onChange={(e) => setPersonaTask(e.target.value)}
            rows={2}
            disabled={personaLoading}
            aria-label="Task to personalize"
            placeholder="e.g. Plan a calm dinner for friends this week…"
            className="mb-2 w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary/60 focus:outline-none disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={personaLoading || personaTask.trim().length === 0}
              onClick={() => void handlePersonaCompose()}
            >
              {personaLoading ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <Sparkles className="mr-1 h-3.5 w-3.5" strokeWidth={1.5} />
              )}
              {personaLoading ? 'Personalizing…' : 'How I’d do this'}
            </Button>
            {personaResult && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={clear}>
                Clear
              </Button>
            )}
            {personaError && <span className="text-[11px] text-destructive">{personaError}</span>}
          </div>
        </div>

        {personaResult && (
          <HowYoudDoItCard
            className="mt-4"
            result={personaResult}
            applying={applyingPersona}
            applyNote={applyNote}
            onApply={() => void handlePersonaApply()}
            onFollowUp={handlePersonaFollowUp}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <Portal.Slot id="actions">
        <ModelSelector withToggles />
      </Portal.Slot>

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

      <div className="flex flex-col h-full">
        {isMobile && (
          <div className="flex flex-row items-center justify-end border-b bg-stone-50 dark:bg-secondary gap-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <ModelSelector withToggles />
          </div>
        )}

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
          readable={stream ?? undefined}
          onSubmit={handleSubmit}
          onStop={stopChatRequest}
          autoFocus={true}
          onResponseFinished={handleResponseFinished}
        />
      </div>
    </>
  );
}

export default function ChatPage() {
  usePageTitle('Chat - Companion Intelligence');

  return <ChatPageContent />;
}
