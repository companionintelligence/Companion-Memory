import { useState, useEffect, memo } from 'react';

import { Sidebar, Tooltip, cn } from '@ci/shadcn';
import { Plus, RefreshCw, Trash2, MessageSquare, ChevronLeft } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import type { Thread } from './types';

interface ChatSidebarProps {
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
  loading: boolean;
  onRefresh: () => void;
}

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
  const [isExpanded, setIsExpanded] = useState(true);

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
        'border-r bg-gradient-to-b from-background/50 to-muted/20 backdrop-blur-sm flex-shrink-0 transition-all duration-300 ease-in-out h-full overflow-auto',
        isExpanded ? 'w-72 lg:w-80' : 'w-16 lg:w-20',
      )}
    >
      <Sidebar.Header
        className={cn(
          'flex flex-row items-center border-b border-border/50 bg-background/80 backdrop-blur-sm',
          isExpanded ? 'gap-3 p-4' : 'justify-center p-2',
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
                className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 transition-all duration-200 hover:bg-primary/20 cursor-pointer"
                aria-label={t('CHAT_SIDEBAR_EXPAND')}
              >
                <MessageSquare className="h-5 w-5 text-primary" />
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
                <ChevronLeft className="h-4 w-4" />
              </button>
            </Tooltip.Trigger>
          </Tooltip>
        )}
      </Sidebar.Header>
      <Sidebar.Content className={cn('transition-all duration-300 ease-in-out', isExpanded ? 'p-3' : 'p-2')}>
        {isExpanded ? (
          <>
            {threads.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                {loading ? (
                  <>
                    <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                      <RefreshCw className="h-8 w-8 animate-spin text-primary/50" />
                    </div>
                    <p className="font-medium">Loading threads...</p>
                  </>
                ) : (
                  <>
                    <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
                      <MessageSquare className="h-8 w-8 opacity-30" />
                    </div>
                    <p className="font-medium mb-2">No threads found</p>
                    <p className="text-sm">Create a new thread to get started</p>
                  </>
                )}
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
                    <div key={thread.id} className="group">
                      <button
                        onClick={() => onSelectThread(thread.id)}
                        className={cn(
                          'w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted/60 transition-all duration-200 relative',
                          selectedThreadId === thread.id && 'bg-primary/10',
                        )}
                      >
                        <div
                          className={cn(
                            'w-2 h-2 rounded-full transition-all duration-200',
                            selectedThreadId === thread.id ? 'bg-primary' : 'bg-muted-foreground/30',
                          )}
                        />
                        <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center flex-shrink-0">
                          <MessageSquare className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0 text-left">
                          <div className="truncate font-medium text-sm">
                            {thread.name || `Thread ${thread.id.slice(0, 8)}`}
                          </div>
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
                              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-all duration-200 cursor-pointer"
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
          // Collapsed state - show only icons
          <div className="space-y-2">
            {/* New Thread Option */}
            <div className="flex justify-center">
              <Tooltip delayDuration={600}>
                <Tooltip.Content>{t('CHAT_THREAD_NEW')}</Tooltip.Content>
                <Tooltip.Trigger asChild>
                  <button
                    onClick={onNewThread}
                    className={cn(
                      'w-10 h-10 rounded-lg bg-primary/10 hover:bg-primary/20 transition-all duration-200 flex items-center justify-center',
                      !selectedThreadId && 'bg-primary/20',
                    )}
                    aria-label={t('CHAT_THREAD_NEW')}
                  >
                    <Plus className="h-5 w-5 text-primary" />
                  </button>
                </Tooltip.Trigger>
              </Tooltip>
            </div>

            {/* Existing Threads */}
            {threads.map((thread) => (
              <div key={thread.id} className="flex justify-center">
                <Tooltip delayDuration={600}>
                  <Tooltip.Content>{thread.name || `Thread ${thread.id.slice(0, 8)}`}</Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <button
                      onClick={() => onSelectThread(thread.id)}
                      className={cn(
                        'w-10 h-10 rounded-lg hover:bg-muted/60 transition-all duration-200 relative flex items-center justify-center',
                        selectedThreadId === thread.id && 'bg-primary/10',
                      )}
                      aria-label={thread.name || `Thread ${thread.id.slice(0, 8)}`}
                    >
                      <div
                        className={cn(
                          'w-2 h-2 rounded-full transition-all duration-200 absolute -top-1 -right-1',
                          selectedThreadId === thread.id ? 'bg-primary' : 'bg-muted-foreground/30',
                        )}
                      />
                      <MessageSquare className="h-5 w-5 text-muted-foreground" />
                    </button>
                  </Tooltip.Trigger>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </Sidebar.Content>
    </div>
  );
});
