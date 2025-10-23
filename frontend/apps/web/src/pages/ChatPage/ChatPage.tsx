import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Portal, useDeviceLayout, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card } from '@ci/shadcn';
import { RefreshCw, Send, X } from '@ci/shadcn/icons';
import { useNavigate, useParams } from 'react-router-dom';

import { useThreadService, useUserContextService, type UserContext } from '@/api';
import { Chat, type FormData } from '@/components/Chat';
import { VoiceModeProvider, useVoiceModeContext } from '@/components/Chat/VoiceModeProvider';
import { ModelSelector } from '@/components/ModelSelector';
import { useChatRequester, useCounter, useModel } from '@/hooks';
import { useCompanionAudioPlayback } from '@/hooks/useCompanionAudioPlayback';

import { ChatSidebar } from './ChatSidebar';
import { KnowledgeSidebar } from './KnowledgeSidebar';
import { type Message } from './types';
import { type AdditionalKnowledgeEntry, useKnowledgeCards } from './useKnowledgeCards';
import { useThreadListService } from './useThreadListService';

function ChatPageContent() {
  const { isMobile } = useDeviceLayout();
  const isMobileDevice = Boolean(isMobile);
  const { isVoiceModeActive } = useVoiceModeContext();

  const resolvedThreadId = useRef<string | null>(null);
  const hasSetInitialMessages = useRef(false);
  const lastProcessedResponseRef = useRef<string>('');

  const navigate = useNavigate();

  const { id: initialThreadId } = useParams<{ id?: string }>();
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [knowledgeMessages, setKnowledgeMessages] = useState<Message[]>([]);
  const [{ selectedModel }] = useModel();
  // Voice state management
  const [selectedVoice, setSelectedVoice] = useState('ryan');

  // Audio playback for voice mode
  const { playCompanionResponse, stopAudioPlayback } = useCompanionAudioPlayback({
    voice: selectedVoice,
  });

  const [
    { threads, loading: threadsLoading, error: threadsError },
    { refetch: refetchThreads, delete: deleteThread },
  ] = useThreadListService();

  const [{ thread, loading: threadLoading }, { refetch: refetchThread }] = useThreadService(
    resolvedThreadId.current,
  );

  const [userContextState, userContextControls] = useUserContextService();
  const { context: userContext, loading: userContextLoading } = userContextState;
  const { refetch: refetchUserContext } = userContextControls;

  const contextExtras = useMemo<AdditionalKnowledgeEntry[]>(
    () => buildContextKnowledgeEntries(userContext),
    [userContext],
  );
  const knowledgeCards = useKnowledgeCards(knowledgeMessages, contextExtras);

  const [{ count: newThreadCount }, { increment: incrementNewThreadCount }] = useCounter();

  const handleNewThread = useCallback(
    (threadId: string) => {
      resolvedThreadId.current = threadId;
      window.history.replaceState({}, '', `/chat/${threadId}`);
      refetchThreads();
      refetchThread();
    },
    [refetchThread, refetchThreads],
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
    setKnowledgeMessages([]);
    hasSetInitialMessages.current = initialThreadId ? false : true;
    resolvedThreadId.current = initialThreadId ?? null;
  }, [initialThreadId]);

  useEffect(() => {
    if (thread && thread.id === resolvedThreadId.current && !hasSetInitialMessages.current) {
      setInitialMessages(thread.messages ?? []);
      hasSetInitialMessages.current = true;
    }
  }, [thread]);

  useEffect(() => {
    const activeThreadId = resolvedThreadId.current;

    if (thread && thread.id === activeThreadId) {
      setKnowledgeMessages(thread.messages ?? []);
    } else if (thread == null) {
      setKnowledgeMessages([]);
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

  // Handle response finished for TTS
  const handleResponseFinished = useCallback(
    (text: string) => {
      if (text.trim()) {
        // Only process new responses
        if (text !== lastProcessedResponseRef.current) {
          lastProcessedResponseRef.current = text;

          // Handle TTS if voice mode is active
          if (isVoiceModeActive) {
            playCompanionResponse(text);
          }
        }
      }

      void refetchThread();
      void refetchUserContext();
    },
    [isVoiceModeActive, playCompanionResponse, refetchThread, refetchUserContext],
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

      <div className="flex h-full min-h-0">
        <div className="flex flex-col h-full flex-1 min-w-0">
          {isMobileDevice && (
            <div className="flex flex-row items-center justify-end border-b bg-stone-50 dark:bg-secondary gap-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
              <ModelSelector withToggles />
            </div>
          )}

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
            onResponseFinished={handleResponseFinished}
            selectedVoice={selectedVoice}
            onVoiceChange={setSelectedVoice}
            onStopAudio={stopAudioPlayback}
          />
        </div>
        <KnowledgeSidebar
          cards={knowledgeCards}
          isLoading={loading || chatRequestStreaming || userContextLoading}
          isMobile={isMobileDevice}
        />
      </div>
    </>
  );
}

function buildContextKnowledgeEntries(context: UserContext | null | undefined): AdditionalKnowledgeEntry[] {
  if (!context) {
    return [];
  }

  const entries: AdditionalKnowledgeEntry[] = [
    {
      id: 'user-context:current-user',
      title: 'Current User Profile',
      sourceLabel: 'User Context',
      data: context.currentUser,
      source: 'system',
    },
  ];

  if (context.familyMembers.length > 0) {
    entries.push({
      id: 'user-context:family',
      title: 'Family Members',
      sourceLabel: 'User Context',
      data: context.familyMembers,
      source: 'system',
    });
  }

  if (context.topPreferences.length > 0) {
    entries.push({
      id: 'user-context:preferences',
      title: 'Top Preferences',
      sourceLabel: 'User Context',
      data: context.topPreferences,
      source: 'system',
    });
  }

  entries.push({
    id: 'user-context:quick-stats',
    title: 'Quick Stats',
    sourceLabel: 'User Context',
    data: context.quickStats,
    source: 'system',
  });

  return entries;
}

export default function ChatPage() {
  usePageTitle('Chat - Companion Intelligence');

  return (
    <VoiceModeProvider>
      <ChatPageContent />
    </VoiceModeProvider>
  );
}
