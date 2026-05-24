import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { Portal, useDeviceLayout, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card } from '@ci/shadcn';
import { RefreshCw, Send, X } from '@ci/shadcn/icons';
import { useNavigate, useParams, Link } from 'react-router-dom';

import { useThreadService } from '@/api';
import { Chat, type FormData } from '@/components/Chat';
import { ModelSelector } from '@/components/ModelSelector';
import { useChatRequester, useCounter, useModel } from '@/hooks';

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
  const [{ selectedModel }] = useModel();

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
      <div className="flex flex-col items-center text-gray-500">
        <div className="w-16 h-16 mx-auto bg-stone-100 rounded-full flex items-center justify-center mb-4">
          <Send className="w-8 h-8 text-zinc-400 relative top-0.5 -left-0.5" />
        </div>
        <p className="text-sm mb-1">Start a conversation with your Companion</p>
        <p className="text-xs text-gray-400">Ask questions, get recommendations, or explore ideas</p>
      </div>
    );
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Link asChild>
                <Link to="/chat">Chat</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            {thread && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>{thread.name || thread.id}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

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
