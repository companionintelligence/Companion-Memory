import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card } from '@ci/shadcn';
import { Image, Palette, Wand2 } from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

import { useThreadService } from '@/api';
import { Chat, type FormData } from '@/components/Chat';
import { ModelSelector } from '@/components/ModelSelector';
import { useChatRequester, useCounter, useModel } from '@/hooks';

import { type Message } from '../ChatPage/types';

export default function ImageGenerationPage() {
  usePageTitle('Image Generation - Companion Intelligence');

  const resolvedThreadId = useRef<string | null>(null);
  const hasSetInitialMessages = useRef(false);

  const navigate = useNavigate();

  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [{ selectedModel }] = useModel();

  const [{ loading: threadLoading }, { refetch: refetchThread }] = useThreadService(resolvedThreadId.current);

  const [{ count: newThreadCount }, { increment: incrementNewThreadCount }] = useCounter();

  const handleNewThread = useCallback(
    (threadId: string) => {
      resolvedThreadId.current = threadId;
      window.history.replaceState({}, '', `/images/${threadId}`);
      refetchThread();
    },
    [refetchThread],
  );

  const [
    { stream, loading: chatRequestLoading, streaming: chatRequestStreaming },
    { submit: submitChatRequest, stop: stopChatRequest },
  ] = useChatRequester({
    threadId: resolvedThreadId.current,
    onNewThread: handleNewThread,
  });

  const navigateToNewChat = useCallback(() => {
    incrementNewThreadCount();
    stopChatRequest();
    resolvedThreadId.current = null;
    navigate('/images');
  }, [incrementNewThreadCount, navigate, stopChatRequest]);

  useEffect(() => {
    setInitialMessages([]);
    hasSetInitialMessages.current = true;
    resolvedThreadId.current = null;
  }, []);

  const handleSubmit = useCallback(
    async (data: FormData, e?: FormEvent) => {
      e?.preventDefault();

      return submitChatRequest(data);
    },
    [submitChatRequest],
  );

  const loading = threadLoading || chatRequestLoading;
  const isSubmitDisabled = selectedModel == null;
  const inputPlaceholder = 'Describe an image to generate...';

  const emptyState = (
    <div className="text-center max-w-md mx-auto mb-6 lg:mb-8">
      <div className="w-16 h-16 lg:w-20 lg:h-20 rounded-full bg-gradient-to-br from-purple-500/10 to-pink-500/20 flex items-center justify-center mx-auto mb-4 lg:mb-6 shadow-lg border border-purple-500/20">
        <Wand2 className="h-8 w-8 lg:h-10 lg:w-10 text-purple-600" />
      </div>
      <h2 className="text-xl lg:text-2xl font-semibold mb-3 bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
        AI Image Generation
      </h2>
      <p className="text-muted-foreground mb-4 lg:mb-6 leading-relaxed text-sm lg:text-base">
        Describe any image you'd like to create and I'll generate it for you using AI
      </p>

      <div className="grid grid-cols-1 gap-3 text-xs">
        <Card className="p-3 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 border-blue-200 dark:border-blue-800/50">
          <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
            <Image className="h-3 w-3" />
            <span className="font-medium">Try: "A futuristic city at sunset"</span>
          </div>
        </Card>

        <Card className="p-3 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/20 dark:to-emerald-950/20 border-green-200 dark:border-green-800/50">
          <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
            <Palette className="h-3 w-3" />
            <span className="font-medium">Try: "A painting of a serene forest"</span>
          </div>
        </Card>

        <Card className="p-3 bg-gradient-to-r from-purple-50 to-violet-50 dark:from-purple-950/20 dark:to-violet-950/20 border-purple-200 dark:border-purple-800/50">
          <div className="flex items-center gap-2 text-purple-700 dark:text-purple-300">
            <Wand2 className="h-3 w-3" />
            <span className="font-medium">Try: "A magical wizard casting spells"</span>
          </div>
        </Card>
      </div>
    </div>
  );

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
              <Breadcrumb.Page>Image Generation</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Portal.Slot id="actions">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={navigateToNewChat}
            className="border-purple-200 text-purple-700 hover:bg-purple-50 dark:border-purple-800 dark:text-purple-300 dark:hover:bg-purple-950/20"
          >
            <Wand2 className="h-4 w-4 mr-2" />
            New Generation
          </Button>
          <ModelSelector />
        </div>
      </Portal.Slot>

      <Chat
        key={`image-generation-${newThreadCount}`}
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
