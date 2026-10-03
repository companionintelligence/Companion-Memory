import { useState } from 'react';

import { AlertDialog, Button, Sheet, cn } from '@ci/shadcn';
import { MessageSquare, MessagesSquare, Plus, Trash2 } from '@ci/shadcn/icons';

import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import type { Thread } from './types';
import { threadLabel } from './useRecentThreads';

interface PhoneChatBarProps {
  threads: Thread[];
  loading: boolean;
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
  /** Called when the list opens: a title lands after the first reply, long after the list was fetched. */
  onRefresh: () => void;
}

/**
 * Thread management for the phone chat: start a new chat, reopen a past one, delete one.
 *
 * `ChatSidebar` does all of this on the desktop, but it portals into `tertiary-navigation`, a slot the phone
 * layout never renders. Until this bar the phone had no New Thread control at all, and its only list of past
 * chats was the drawer's Chat submenu — two levels down, read-only, and not mentioned anywhere in the chat itself.
 *
 * Renaming is not offered: the server has no way to rename a thread (the title is only ever written by the
 * background job), and the desktop sidebar has none either.
 */
export function PhoneChatBar({
  threads,
  loading,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onRefresh,
}: PhoneChatBarProps) {
  const fmt = useDateTimeFormat();
  const [listOpen, setListOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);

  const handleListOpenChange = (open: boolean) => {
    setListOpen(open);

    if (open) {
      onRefresh();
    }
  };

  const handleSelect = (threadId: string) => {
    setListOpen(false);
    onSelectThread(threadId);
  };

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 px-2 pt-1">
      <Button type="button" variant="ghost" onClick={() => handleListOpenChange(true)}>
        <MessagesSquare />
        Chats
      </Button>

      <Button type="button" variant="outline" onClick={onNewThread}>
        <Plus />
        New chat
      </Button>

      <Sheet open={listOpen} onOpenChange={handleListOpenChange}>
        <Sheet.Content
          side="bottom"
          className="max-h-[min(80dvh,var(--vv-height,100dvh))] gap-0 rounded-t-2xl px-0 pb-[max(1rem,var(--safe-area-bottom))] pt-3"
        >
          <div className="mx-auto h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />

          <Sheet.Header className="px-4 pb-2">
            <Sheet.Title>Chats</Sheet.Title>
            <Sheet.Description>
              Pick up a past conversation, or delete one you are done with.
            </Sheet.Description>
          </Sheet.Header>

          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            {threads.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                {loading ? 'Loading chats…' : 'No chats yet.'}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {threads.map((thread) => {
                  const label = threadLabel(thread, fmt);
                  const current = thread.id === selectedThreadId;

                  return (
                    <li key={thread.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-current={current ? 'true' : undefined}
                        onClick={() => handleSelect(thread.id)}
                        className={cn(
                          'flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-left text-sm transition',
                          current
                            ? 'bg-primary/10 text-primary'
                            : 'hover:bg-accent hover:text-accent-foreground',
                        )}
                      >
                        <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                      </button>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${label}`}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setPendingDelete(thread)}
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Sheet.Content>
      </Sheet>

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Delete this chat?</AlertDialog.Title>
            <AlertDialog.Description>
              {pendingDelete
                ? `“${threadLabel(pendingDelete, fmt)}” and its messages will be deleted.`
                : null}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              // The confirm carries its own destructive styling: AlertDialog.Action is a primary button.
              className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60"
              onClick={() => {
                if (pendingDelete) {
                  onDeleteThread(pendingDelete.id);
                }
              }}
            >
              Delete
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </div>
  );
}
