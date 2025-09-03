import { type ReactNode, useCallback } from 'react';

import { Button, Dialog, cn } from '@ci/shadcn';
import { Send } from '@ci/shadcn/icons';

import { useThreadService } from '@/api';
import { Chat } from '@/components/Chat';
import { Tag } from '@/components/Tag';
import { useChatRequester, useDeviceLayout } from '@/hooks';

interface Props {
  open?: boolean;
  title?: string;
  description?: ReactNode;
  tags?: string[];
  imageUrl?: string;
  threadId?: string;
  onClose?: () => void;
}

export function FeedModal({ open = false, title, description, tags, imageUrl, threadId, onClose }: Props) {
  if (!title && !description) {
    return null;
  }

  const { isMobile } = useDeviceLayout();

  const [{ thread }] = useThreadService(threadId ?? null);

  const [{ stream, streaming: chatRequestStreaming }, { submit: submitChatRequest, stop: stopChatRequest }] =
    useChatRequester({
      threadId: threadId ?? null,
    });

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      onClose?.();
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content className="h-[calc(100%-2rem)] md:max-w-[70vw] md:h-[70vh] p-0 flex flex-col gap-0">
        <Dialog.Header
          className={cn(
            'flex items-center border-b bg-stone-50 rounded-t-2xl',
            isMobile ? 'gap-2 p-3' : 'flex-row gap-4 p-4 pb-3',
          )}
        >
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description className="hidden">
            Interact with an action suggested by your AI agent
          </Dialog.Description>

          {tags && (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <Tag key={tag} text={tag} />
              ))}
            </div>
          )}
        </Dialog.Header>

        <div className="flex flex-1 min-h-0">
          {!isMobile && (
            <div className="flex flex-col gap-4 p-4 border-r flex-1/2">
              {imageUrl && (
                <div className="aspect-video rounded-lg overflow-hidden bg-stone-100">
                  <img src={imageUrl} alt={title} className="w-full h-full object-cover" />
                </div>
              )}

              <div className="flex-1">{description}</div>

              <div className="bg-stone-50 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-2">Quick Actions</h3>
                <div className="space-y-2">
                  <Button variant="outline" size="sm" className="w-full justify-start">
                    Save to favorites
                  </Button>
                  <Button variant="outline" size="sm" className="w-full justify-start">
                    Share with family
                  </Button>
                  <Button variant="outline" size="sm" className="w-full justify-start">
                    Add to calendar
                  </Button>
                </div>
              </div>
            </div>
          )}

          <Chat
            placeholder="Ask about this content..."
            streaming={chatRequestStreaming}
            messages={thread?.messages}
            readable={stream ?? undefined}
            onSubmit={submitChatRequest}
            onStop={stopChatRequest}
            emptyState={
              <div className="text-center text-gray-500 mt-8">
                <div className="w-16 h-16 mx-auto mb-4 bg-stone-100 rounded-full flex items-center justify-center">
                  <Send className="w-8 h-8 text-zinc-400 relative top-0.5 -left-0.5" />
                </div>
                <p className="text-sm">Start a conversation about this content</p>
                <p className="text-xs text-gray-400 mt-1">
                  Ask questions, get recommendations, or explore ideas
                </p>
              </div>
            }
          />
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
