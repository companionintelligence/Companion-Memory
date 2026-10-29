import { useState, useEffect, useRef, memo } from 'react';

import { Sidebar, Tooltip, cn } from '@ci/shadcn';
import { Plus, RefreshCw, Trash2, MessageSquare, PanelLeftClose, PanelLeftOpen } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { LoadingRegion, ThreadRowsSkeleton } from '@/components/MemoryHub/MemoryHubSkeletons';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

import { ThreadMark, threadActivity } from './ThreadMark';
import type { Thread } from './types';
import { threadLabel } from './useRecentThreads';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A busy or failed thread says so in its name, since the dot on its tile is only a picture. */
function threadAccessibleName(thread: Thread, fmt: DateTimeFormatter, t: Translate): string {
  const label = threadLabel(thread, fmt);
  const activity = threadActivity(thread);

  if (activity === 'busy') {
    return `${label}, ${t('CHAT_THREAD_STATUS_BUSY')}`;
  }

  return activity === 'failed' ? `${label}, ${t('CHAT_THREAD_STATUS_FAILED')}` : label;
}

/**
 * The collapsed rail's tooltip: the name, what the thread is about when there is a
 * description, and when it last changed. A tile only has two letters to go on.
 */
function ThreadTooltipBody({ thread, fmt, t }: { thread: Thread; fmt: DateTimeFormatter; t: Translate }) {
  const activity = threadActivity(thread);
  const updated = thread.updatedAt ? new Date(thread.updatedAt) : null;
  const when =
    updated && !Number.isNaN(updated.getTime())
      ? fmt.dateTime(updated, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : null;

  return (
    <div className="max-w-64 space-y-0.5 text-left">
      <p className="font-semibold">{threadLabel(thread, fmt)}</p>
      {thread.description ? <p className="line-clamp-2 opacity-85">{thread.description}</p> : null}
      {activity ? (
        <p className="opacity-85">
          {t(activity === 'busy' ? 'CHAT_THREAD_STATUS_BUSY' : 'CHAT_THREAD_STATUS_FAILED')}
        </p>
      ) : when ? (
        <p className="opacity-70">{t('CHAT_THREAD_UPDATED', { time: when })}</p>
      ) : null}
    </div>
  );
}

interface ChatSidebarProps {
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
  loading: boolean;
  onRefresh: () => void;
}

/**
 * Thread management for the desktop chat: create, pick, delete, refresh.
 *
 * Portaled into `tertiary-navigation`, a slot only the desktop layout renders —
 * on the phone this component mounts and portals into nothing. The phone has
 * `PhoneChatBar` for the same jobs, and the Power Rail drawer's Chat submenu
 * for switching, which shows the same threads under the same names (see
 * `threadLabel`) as read-only links.
 */
export const ChatSidebar = memo(function ChatSidebar({
  threads,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  loading,
  onRefresh,
}: ChatSidebarProps) {
  const { t } = useTranslation();
  const fmt = useDateTimeFormat();
  const [isExpanded, setIsExpanded] = useState(true);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Keep the open thread on screen. A thread opened from a link or the rail's
  // submenu can sit far down a long list, and then nothing visible says which
  // one is open. Only scrolls when it is out of view, so clicking a visible row
  // doesn't move the list under the pointer.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = selectedThreadId
      ? scroller?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(selectedThreadId)}"]`)
      : null;

    if (!scroller || !row || typeof scroller.scrollTo !== 'function') {
      return;
    }

    const view = scroller.getBoundingClientRect();
    const box = row.getBoundingClientRect();

    // The list's own scroll, not `scrollIntoView`, which also scrolls every
    // ancestor and pushed the pinned header off the top.
    if (box.top < view.top || box.bottom > view.bottom) {
      scroller.scrollTo({ top: scroller.scrollTop + (box.top - view.top) - (view.height - box.height) / 2 });
    }
  }, [selectedThreadId, isExpanded, threads.length]);

  // Auto-collapse on mobile screens
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) {
        // md breakpoint
        setIsExpanded(false);
      } else {
        setIsExpanded(true);
      }
    };

    // Set initial state
    handleResize();

    window.addEventListener('resize', handleResize);

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div
      className={cn(
        'border-r bg-gradient-to-b from-background/50 to-muted/20 backdrop-blur-sm flex-shrink-0 transition-all duration-300 ease-in-out h-full flex flex-col overflow-hidden',
        isExpanded ? 'w-72 lg:w-80' : 'w-16 lg:w-20',
      )}
    >
      <Sidebar.Header
        className={cn(
          'flex shrink-0 items-center border-b border-border/50 bg-background/80 backdrop-blur-sm',
          isExpanded ? 'flex-row gap-3 p-4' : 'flex-col gap-2 px-2 py-3',
        )}
      >
        {/* Expanded, this is just the panel's icon — the click is a no-op, so it
            is taken out of the tab order rather than left as a nameless button.
            The Tooltip is gated as a whole: a Tooltip with no Content still
            points aria-describedby at an element that was never rendered. */}
        {isExpanded ? (
          <div
            className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0"
            aria-hidden="true"
          >
            <MessageSquare className="h-5 w-5 text-primary" />
          </div>
        ) : (
          <Tooltip delayDuration={600}>
            <Tooltip.Content>{t('CHAT_SIDEBAR_EXPAND')}</Tooltip.Content>
            <Tooltip.Trigger asChild>
              <button
                onClick={() => setIsExpanded(true)}
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 text-muted-foreground transition-colors duration-200 hover:bg-muted/80 hover:text-foreground cursor-pointer"
                aria-label={t('CHAT_SIDEBAR_EXPAND')}
              >
                <PanelLeftOpen className="h-5 w-5" />
              </button>
            </Tooltip.Trigger>
          </Tooltip>
        )}
        {!isExpanded && (
          // Pinned with the toggle, so starting a chat never needs a scroll back up.
          <Tooltip delayDuration={300}>
            <Tooltip.Content side="right">{t('CHAT_THREAD_NEW')}</Tooltip.Content>
            <Tooltip.Trigger asChild>
              <button
                onClick={onNewThread}
                className={cn(
                  'w-10 h-10 rounded-lg border border-dashed border-primary/40 text-primary transition-colors duration-200 flex items-center justify-center hover:border-primary hover:bg-primary/10',
                  !selectedThreadId && 'border-solid border-primary bg-primary/10',
                )}
                aria-label={t('CHAT_THREAD_NEW')}
              >
                <Plus className="h-5 w-5" />
              </button>
            </Tooltip.Trigger>
          </Tooltip>
        )}
        {isExpanded && (
          <>
            <h2 className="text-lg font-semibold flex-shrink-0">Chat Threads</h2>
            <Tooltip delayDuration={600}>
              <Tooltip.Content>{t('CHAT_THREADS_REFRESH')}</Tooltip.Content>
              <Tooltip.Trigger asChild>
                <button
                  onClick={onRefresh}
                  className="p-2 rounded-lg hover:bg-muted/80 transition-all duration-200 flex-shrink-0"
                  aria-label={t('CHAT_THREADS_REFRESH')}
                  disabled={loading}
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </Tooltip.Trigger>
            </Tooltip>
          </>
        )}
        {isExpanded && (
          <Tooltip delayDuration={600}>
            <Tooltip.Content>{t('CHAT_SIDEBAR_COLLAPSE')}</Tooltip.Content>
            <Tooltip.Trigger asChild>
              <button
                onClick={() => setIsExpanded(false)}
                className="p-2 rounded-lg hover:bg-muted/80 transition-all duration-200 flex-shrink-0 ml-auto"
                aria-label={t('CHAT_SIDEBAR_COLLAPSE')}
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </Tooltip.Trigger>
          </Tooltip>
        )}
      </Sidebar.Header>
      <Sidebar.Content
        ref={scrollerRef}
        className={cn('transition-all duration-300 ease-in-out', isExpanded ? 'p-3' : 'px-2 py-3')}
      >
        {isExpanded ? (
          <>
            {threads.length === 0 && loading ? (
              <LoadingRegion label="Loading threads" className="p-2">
                <ThreadRowsSkeleton />
              </LoadingRegion>
            ) : threads.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="h-8 w-8 opacity-30" />
                </div>
                <p className="font-medium mb-2">No threads found</p>
                <p className="text-sm">Create a new thread to get started</p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* New Thread Option */}
                <div className="p-2">
                  <button
                    onClick={onNewThread}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-all duration-200 group',
                      !selectedThreadId && 'border-primary/50 bg-primary/5',
                    )}
                  >
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                      <Plus className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                    <span className="font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                      New Thread
                    </span>
                  </button>
                </div>

                {/* Separator */}
                {threads.length > 0 && (
                  <div className="relative py-3">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border/50" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase tracking-wider">
                      <span className="bg-gradient-to-r from-background/50 to-muted/20 px-3 text-muted-foreground font-medium">
                        Recent Threads
                      </span>
                    </div>
                  </div>
                )}

                {/* Existing Threads */}
                <div className="space-y-2">
                  {threads.map((thread) => (
                    <div key={thread.id} className="group" data-thread-id={thread.id}>
                      <button
                        onClick={() => onSelectThread(thread.id)}
                        className={cn(
                          'w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted/60 transition-all duration-200 relative',
                          selectedThreadId === thread.id && 'bg-primary/10',
                        )}
                      >
                        <ThreadMark
                          thread={thread}
                          selected={selectedThreadId === thread.id}
                          size="sm"
                          fmt={fmt}
                        />
                        <div className="flex-1 min-w-0 text-left">
                          <div className="truncate font-medium text-sm">{threadLabel(thread, fmt)}</div>
                          {thread.description && (
                            <div className="text-xs text-muted-foreground truncate mt-0.5">
                              {thread.description}
                            </div>
                          )}
                        </div>
                        <Tooltip delayDuration={600}>
                          <Tooltip.Content>{t('CHAT_THREAD_DELETE')}</Tooltip.Content>
                          <Tooltip.Trigger asChild>
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteThread(thread.id);
                              }}
                              className="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 p-1.5 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-all duration-200 cursor-pointer"
                              aria-label={t('CHAT_THREAD_DELETE')}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onDeleteThread(thread.id);
                                }
                              }}
                            >
                              <Trash2 size={14} />
                            </div>
                          </Tooltip.Trigger>
                        </Tooltip>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          // Collapsed: one tile per thread under the pinned New thread button. Each
          // tile carries its thread's initials and colour, and a bar marks the open
          // one, so the rail reads without hovering; the tooltip adds name and time.
          <div className="flex flex-col items-center gap-2">
            {threads.map((thread) => {
              const selected = selectedThreadId === thread.id;

              return (
                <div
                  key={thread.id}
                  className="relative flex w-full justify-center"
                  data-thread-id={thread.id}
                >
                  {selected && (
                    <span
                      className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                      aria-hidden="true"
                    />
                  )}
                  <Tooltip delayDuration={300}>
                    <Tooltip.Content side="right">
                      <ThreadTooltipBody thread={thread} fmt={fmt} t={t} />
                    </Tooltip.Content>
                    <Tooltip.Trigger asChild>
                      <button
                        onClick={() => onSelectThread(thread.id)}
                        className="rounded-lg transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:hover:scale-100"
                        aria-label={threadAccessibleName(thread, fmt, t)}
                        aria-current={selected ? 'true' : undefined}
                      >
                        <ThreadMark thread={thread} selected={selected} fmt={fmt} />
                      </button>
                    </Tooltip.Trigger>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        )}
      </Sidebar.Content>
    </div>
  );
});
