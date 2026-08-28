import { useCallback, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';

import { ErrorPage, LoadingPage, useDeviceLayout } from '@ci/common';
import { Dialog, IconButton, cn } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';

import { useActionService, useThreadService } from '@/api';
import { Chat } from '@/components/Chat';
import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { InlineModal } from '@/components/InlineModal';
import { Markdown } from '@/components/Markdown';
import { Tag } from '@/components/Tag';
import { useChatRequester } from '@/hooks';

interface Props {
  actionId?: string | null;
  onClose?: () => void;
}

export function FeedModal({ onClose }: Props) {
  const { id: actionId } = useParams<{ id?: string }>();

  const { t } = useTranslation();
  const { isMobile } = useDeviceLayout();

  const [{ data: action, loading: actionLoading, error: actionError }] = useActionService(actionId ?? null);
  const [{ thread }] = useThreadService(action?.threadId ?? null);
  const [
    { stream, loading: chatRequestLoading, streaming: chatRequestStreaming, hasStartedReceiving },
    { submit: submitChatRequest, stop: stopChatRequest, attach: attachChatStream, detach: detachChatStream },
  ] = useChatRequester({
    threadId: thread?.id ?? null,
  });

  useEffect(() => {
    if (thread?.id && (thread.generationStatus === 'queued' || thread.generationStatus === 'running')) {
      void attachChatStream(thread.id);
    }
  }, [thread?.id, thread?.generationStatus, attachChatStream]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        detachChatStream();
        onClose?.();
      }
    },
    [detachChatStream, onClose],
  );

  useLayoutEffect(() => {
    if (!isMobile) {
      return;
    }

    // PageContent is the page scroller. The chat used to be `absolute inset-0`
    // inside it, so opening an action while scrolled down painted the dialog at
    // the top of the page — out of view. Scroll back, then the portaled dialog
    // covers the visible content and takes focus.
    document.querySelector<HTMLElement>('[data-page-scroll]')?.scrollTo({ top: 0, behavior: 'instant' });
  }, [isMobile]);

  const actionContext = useMemo(() => {
    if (!action?.metadata || typeof action.metadata !== 'object') {
      return undefined;
    }

    const context = (action.metadata as { context?: string }).context;

    return context && context.trim().length > 0 ? context : undefined;
  }, [action?.metadata]);

  const rationaleText = actionContext ?? 'No rationale available yet.';

  const chatContext = useMemo(() => {
    if (!action) {
      return null;
    }

    return {
      title: action.title,
      body: action.text,
      sourceKind: 'action' as const,
      sourceId: action.id,
    };
  }, [action]);

  const messages = useMemo(() => {
    const baseMessages = thread?.messages ?? [];
    const actionMessage =
      action?.text != null
        ? [
            {
              role: 'assistant',
              content: action.text,
            },
          ]
        : [];

    const generating = thread?.generationStatus === 'queued' || thread?.generationStatus === 'running';
    const withoutInFlight =
      generating && baseMessages[baseMessages.length - 1]?.role === 'assistant'
        ? baseMessages.slice(0, -1)
        : baseMessages;

    if (isMobile) {
      return [...actionMessage, ...withoutInFlight];
    }

    const hasAssistantMessage = withoutInFlight.some((message) => message.role === 'assistant');

    if (!hasAssistantMessage) {
      return [...actionMessage, ...withoutInFlight];
    }

    return withoutInFlight;
  }, [thread, isMobile, action?.text]);

  const renderTitle = !(actionLoading || actionError);
  let emptyState: ReactNode;

  if (actionLoading) {
    emptyState = <LoadingPage />;
  } else if (actionError) {
    emptyState = <ErrorPage error={actionError} />;
  }

  if (isMobile) {
    return (
      <InlineModal
        open
        onClose={onClose}
        portalId="content-modal"
        autoFocus
        aria-label={action?.title ?? 'Action'}
      >
        <div className="flex items-center justify-between border-b bg-stone-50 dark:bg-secondary gap-2 p-2 pt-[max(1rem,env(safe-area-inset-top))]">
          {/* Spacer balancing the close button so the title stays centred. The
              model selector that used to sit here now lives in Settings ▸ Model. */}
          <div className="flex-1" />

          <div className="font-bold">{action?.title}</div>

          <div className="flex flex-1 justify-end gap-1">
            {chatContext ? <ChatWithAgentMenu context={chatContext} size="sm" /> : null}
            <IconButton variant="ghost" onClick={onClose} label={t('COMMON_CLOSE')}>
              <X />
            </IconButton>
          </div>
        </div>

        <Chat
          autoFocus
          placeholder={renderTitle ? 'Continue the conversation...' : ''}
          disabled={!renderTitle}
          loading={chatRequestLoading}
          streaming={chatRequestStreaming}
          hasStartedReceiving={hasStartedReceiving}
          messages={messages}
          readable={stream ?? undefined}
          onSubmit={submitChatRequest}
          onStop={stopChatRequest}
          emptyState={emptyState}
        />
      </InlineModal>
    );
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <Dialog.Content
        className="h-[calc(100%-2rem)] md:max-w-[70vw] md:h-[70vh] p-0 flex flex-col gap-0"
        showCloseButton={false}
      >
        <Dialog.Header
          className={cn(
            'flex flex-row items-center justify-between border-b bg-stone-50 dark:bg-secondary rounded-t-lg gap-2 p-2 pl-4',
          )}
        >
          <Dialog.Title>{action?.title}</Dialog.Title>
          <Dialog.Description className="hidden">
            Interact with an action suggested by your AI agent
          </Dialog.Description>

          <div className="flex items-center justify-between flex-1">
            {(action?.tags?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-2">
                {action?.tags.map((tag) => <Tag key={tag} text={tag} />)}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end">
            <IconButton variant="ghost" onClick={onClose} label={t('COMMON_CLOSE')}>
              <X />
            </IconButton>
          </div>
        </Dialog.Header>

        <div className="flex flex-1 min-h-0">
          <div className="flex flex-col gap-4 p-4 border-r flex-1/2">
            {action?.imageUrl && (
              <div className="aspect-video rounded-lg overflow-hidden bg-stone-100">
                <img src={action.imageUrl} alt={action.title} className="w-full h-full object-cover" />
              </div>
            )}

            <div className="flex-1 prose dark:prose-invert">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Why this suggestion
                </div>
                {chatContext ? <ChatWithAgentMenu context={chatContext} size="sm" /> : null}
              </div>
              <Markdown>{rationaleText}</Markdown>
            </div>
          </div>

          <Chat
            placeholder={renderTitle ? 'Continue the conversation...' : ''}
            disabled={!renderTitle}
            loading={chatRequestLoading}
            streaming={chatRequestStreaming}
            hasStartedReceiving={hasStartedReceiving}
            messages={messages}
            readable={stream ?? undefined}
            onSubmit={submitChatRequest}
            onStop={stopChatRequest}
            emptyState={emptyState}
          />
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
