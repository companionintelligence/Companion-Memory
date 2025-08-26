import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card } from '@ci/shadcn';
import { RefreshCw, MessageSquare, X } from '@ci/shadcn/icons';
import { useNavigate, useParams } from 'react-router-dom';

import { Chat, type FormData } from '@/components/Chat';
import { ModelSelector } from '@/components/ModelSelector';
import { useChatRequester, useCounter, useModel } from '@/hooks';

import { ChatSidebar } from './ChatSidebar';
import { type Message } from './types';
import { useThreadListService } from './useThreadListService';
import { useThreadService } from './useThreadService';

export default function ChatPage() {
  usePageTitle('Chat - Companion Intelligence');

  const resolvedThreadId = useRef<string | null>(null);
  const hasSetInitialMessages = useRef(false);

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
    { stream, loading: chatRequestLoading, streaming: chatRequestStreaming },
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
      <div className="text-center max-w-md mx-auto mb-6 lg:mb-8">
        <div className="w-16 h-16 lg:w-20 lg:h-20 rounded-full bg-gradient-to-br from-primary/10 to-primary/20 flex items-center justify-center mx-auto mb-4 lg:mb-6 shadow-lg border border-primary/20">
          <MessageSquare className="h-8 w-8 lg:h-10 lg:w-10 text-primary" />
        </div>
        <h2 className="text-xl lg:text-2xl font-semibold mb-3 bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
          Welcome to Chat
        </h2>
        <p className="text-muted-foreground mb-4 lg:mb-6 leading-relaxed text-sm lg:text-base">
          Choose a thread from the sidebar or create a new one to start chatting with AI
        </p>
      </div>
    );
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Link href="/chat">Chat</Breadcrumb.Link>
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
        <ModelSelector />
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

      <Chat
        key={initialThreadId ?? `new-thread-${newThreadCount}`}
        loading={loading}
        streaming={chatRequestStreaming}
        disabled={isSubmitDisabled}
        placeholder={inputPlaceholder}
        messages={initialMessages}
        emptyState={emptyState}
        readable={stream ?? undefined}
        onSubmit={handleSubmit}
        onStop={stopChatRequest}
        autoFocus={true}
      />
    </>
  );
}
