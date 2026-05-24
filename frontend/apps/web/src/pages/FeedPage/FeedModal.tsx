import { useCallback, useMemo, type ReactNode } from 'react';

import { ErrorPage, LoadingPage, useDeviceLayout } from '@ci/common';
import { Button, Dialog, Popover, cn } from '@ci/shadcn';
import { Settings, X } from '@ci/shadcn/icons';
import { useParams } from 'react-router-dom';

import { useActionService, useThreadService } from '@/api';
import { Chat } from '@/components/Chat';
import { InlineModal } from '@/components/InlineModal';
import { Markdown } from '@/components/Markdown';
import { ModelSelector } from '@/components/ModelSelector';
import { Tag } from '@/components/Tag';
import { useChatRequester } from '@/hooks';

interface Props {
  actionId?: string | null;
  onClose?: () => void;
}

export function FeedModal({ onClose }: Props) {
  const { id: actionId } = useParams<{ id?: string }>();

  const { isMobile } = useDeviceLayout();

  const [{ data: action, loading: actionLoading, error: actionError }] = useActionService(actionId ?? null);
  const [{ thread }] = useThreadService(action?.threadId ?? null);
  const [
    { stream, loading: chatRequestLoading, streaming: chatRequestStreaming, hasStartedReceiving },
    { submit: submitChatRequest, stop: stopChatRequest },
  ] = useChatRequester({
    threadId: thread?.id ?? null,
  });

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      onClose?.();
    }
  }, []);

  const actionContext = useMemo(() => {
    if (!action?.metadata || typeof action.metadata !== 'object') {
      return undefined;
    }

    const context = (action.metadata as { context?: string }).context;

    return context && context.trim().length > 0 ? context : undefined;
  }, [action?.metadata]);

  const rationaleText = actionContext ?? 'No rationale available yet.';

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

    if (isMobile) {
      return [...actionMessage, ...baseMessages];
    }

    const hasAssistantMessage = baseMessages.some((message) => message.role === 'assistant');

    if (!hasAssistantMessage) {
      return [...actionMessage, ...baseMessages];
    }

    return baseMessages;
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
      <InlineModal open onClose={onClose}>
        <div className="flex items-center justify-between border-b bg-stone-50 dark:bg-secondary gap-2 p-2 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex-1">
            <Popover>
              <Popover.Trigger>
                <Button className="flex-1" variant="ghost" size="icon">
                  <Settings />
                </Button>
              </Popover.Trigger>
              <Popover.Content className="p-2 relative left-2 w-auto">
                <ModelSelector withToggles />
              </Popover.Content>
            </Popover>
          </div>

          <div className="font-bold">{action?.title}</div>

          <div className="flex flex-1 justify-end">
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X />
            </Button>
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

          <ModelSelector withToggles />

          <div className="flex items-center justify-end">
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X />
            </Button>
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
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Why this suggestion
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
