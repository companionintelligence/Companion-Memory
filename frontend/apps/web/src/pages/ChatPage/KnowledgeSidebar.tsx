import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';

import { cn } from '@ci/shadcn';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2, Sparkles } from '@ci/shadcn/icons';

import type { KnowledgeCard } from './types';

interface KnowledgeSidebarProps {
  cards: KnowledgeCard[];
  isLoading: boolean;
  isMobile: boolean;
}

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 600;
const COLLAPSED_WIDTH = 48;

export const KnowledgeSidebar = memo(function KnowledgeSidebar({
  cards,
  isLoading,
  isMobile,
}: KnowledgeSidebarProps) {
  const [isExpanded, setIsExpanded] = useState(!isMobile);
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const listenersRef = useRef({
    mouseMove: null as ((event: MouseEvent) => void) | null,
    mouseUp: null as ((event: MouseEvent) => void) | null,
    touchMove: null as ((event: TouchEvent) => void) | null,
    touchEnd: null as ((event: TouchEvent) => void) | null,
  });

  useEffect(() => {
    setIsExpanded(!isMobile);
  }, [isMobile]);

  useEffect(() => {
    setExpandedCards((prev) => {
      if (cards.length === 0) {
        return {};
      }

      const next: Record<string, boolean> = {};

      for (const card of cards) {
        if (Object.prototype.hasOwnProperty.call(prev, card.id)) {
          next[card.id] = prev[card.id];
        }
      }

      const latest = cards[cards.length - 1];

      if (latest && !Object.prototype.hasOwnProperty.call(next, latest.id)) {
        next[latest.id] = true;
      }

      return next;
    });
  }, [cards]);

  const toggleCard = useCallback((id: string) => {
    setExpandedCards((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? false),
    }));
  }, []);

  const detachListeners = useCallback(() => {
    const { mouseMove, mouseUp, touchMove, touchEnd } = listenersRef.current;

    if (mouseMove) {
      document.removeEventListener('mousemove', mouseMove);
    }

    if (mouseUp) {
      document.removeEventListener('mouseup', mouseUp);
    }

    if (touchMove) {
      document.removeEventListener('touchmove', touchMove);
    }

    if (touchEnd) {
      document.removeEventListener('touchend', touchEnd);
    }

    listenersRef.current = {
      mouseMove: null,
      mouseUp: null,
      touchMove: null,
      touchEnd: null,
    };
  }, []);

  const finishResize = useCallback(() => {
    setIsResizing(false);
    resizeStateRef.current = null;
    detachListeners();
  }, [detachListeners]);

  const handleResize = useCallback((clientX: number) => {
    const state = resizeStateRef.current;

    if (!state) {
      return;
    }

    const delta = state.startX - clientX;
    const nextWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, state.startWidth + delta));

    setSidebarWidth(nextWidth);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent | ReactTouchEvent) => {
      if (isMobile || !isExpanded) {
        return;
      }

      let clientX: number | null = null;

      if ('touches' in event) {
        const touch = event.touches[0];

        if (touch) {
          clientX = touch.clientX;
        }
      } else {
        clientX = event.clientX;
      }

      if (clientX == null) {
        return;
      }

      event.preventDefault();

      resizeStateRef.current = {
        startX: clientX,
        startWidth: sidebarWidth,
      };

      setIsResizing(true);

      const mouseMove = (moveEvent: MouseEvent) => {
        moveEvent.preventDefault();
        handleResize(moveEvent.clientX);
      };

      const mouseUp = (upEvent: MouseEvent) => {
        upEvent.preventDefault();
        finishResize();
      };

      const touchMove = (touchEvent: TouchEvent) => {
        if (touchEvent.touches.length === 0) {
          return;
        }

        handleResize(touchEvent.touches[0].clientX);
      };

      const touchEnd = () => {
        finishResize();
      };

      listenersRef.current = {
        mouseMove,
        mouseUp,
        touchMove,
        touchEnd,
      };

      document.addEventListener('mousemove', mouseMove);
      document.addEventListener('mouseup', mouseUp);
      document.addEventListener('touchmove', touchMove);
      document.addEventListener('touchend', touchEnd);
    },
    [finishResize, handleResize, isExpanded, isMobile, sidebarWidth],
  );

  useEffect(() => {
    return () => {
      detachListeners();
    };
  }, [detachListeners]);

  useEffect(() => {
    if (isMobile) {
      setSidebarWidth(DEFAULT_WIDTH);
    }
  }, [isMobile]);

  useEffect(() => {
    if (!isExpanded) {
      finishResize();
    }
  }, [finishResize, isExpanded]);

  const hasCards = cards.length > 0;
  const headerCount = cards.length > 99 ? '99+' : String(cards.length);

  return (
    <aside
      className={cn(
        'relative flex h-full flex-col border-l border-border/60 bg-gradient-to-b from-background/70 to-muted/30 backdrop-blur-sm transition-[width] duration-150 ease-in-out',
      )}
      style={{ width: isExpanded ? sidebarWidth : COLLAPSED_WIDTH }}
    >
      {!isMobile && isExpanded && (
        <div
          className="absolute left-0 top-0 z-20 flex h-full w-2 -translate-x-1 cursor-col-resize items-center justify-center"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={Math.round(sidebarWidth)}
          onMouseDown={handleResizeStart}
          onTouchStart={handleResizeStart}
        >
          <div
            className={cn(
              'h-12 w-[3px] rounded-full bg-border/70 transition-colors',
              isResizing && 'bg-primary',
            )}
          />
        </div>
      )}
      <div
        className={cn(
          'flex items-center border-b border-border/40 transition-colors duration-200',
          isExpanded ? 'justify-between px-4 py-3 gap-3' : 'justify-center py-3',
        )}
      >
        <button
          type="button"
          aria-label={isExpanded ? 'Collapse knowledge panel' : 'Expand knowledge panel'}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          {isExpanded ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
        {isExpanded ? (
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="truncate">Knowledge</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {headerCount}
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 text-[10px] font-medium text-muted-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            <span>{headerCount}</span>
          </div>
        )}
      </div>

      {isExpanded ? (
        <div className="flex-1 overflow-y-auto px-3 py-4">
          {hasCards ? (
            <div className="space-y-3">
              {cards.map((card) => {
                const expanded = Boolean(expandedCards[card.id]);

                return (
                  <div
                    key={card.id}
                    className={cn(
                      'rounded-xl border border-border/50 bg-background/90 shadow-sm transition hover:border-primary/40',
                      expanded && 'border-primary/40',
                    )}
                  >
                    <button type="button" className="w-full text-left" onClick={() => toggleCard(card.id)}>
                      <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{card.title}</p>
                          <p className="truncate text-xs text-muted-foreground">{card.sourceLabel}</p>
                        </div>
                        {expanded ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="border-t border-border/40" />
                      <div
                        className={cn(
                          'relative px-4 py-3 text-xs leading-5 text-foreground bg-muted/10 rounded-b-xl',
                          expanded ? 'max-h-[60vh] overflow-y-auto' : 'max-h-32 overflow-hidden',
                        )}
                      >
                        <div className="space-y-2 pr-2">
                          <KnowledgeValue value={card.data ?? card.rawJson ?? card.formattedJson} depth={0} />
                        </div>
                        {!expanded && (
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background via-background/70 to-transparent" />
                        )}
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/50 bg-muted/20 px-4 py-6 text-center">
              {isLoading ? (
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              ) : (
                <Sparkles className="h-6 w-6 text-primary/60" />
              )}
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">No knowledge captured yet</p>
                <p className="text-xs text-muted-foreground">
                  Tool responses will appear here as the conversation discovers new information.
                </p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </aside>
  );
});

const MAX_ARRAY_ITEMS = 10;

function KnowledgeValue({ value, depth }: { value: unknown; depth: number }) {
  if (value === undefined) {
    return <span className="text-muted-foreground italic">No data</span>;
  }

  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground italic">Empty list</span>;
    }

    const items = value.slice(0, MAX_ARRAY_ITEMS);
    const remaining = value.length - items.length;

    return (
      <div className={cn('space-y-2', depth > 0 && 'border-l border-border/30 pl-3')}>
        {items.map((item, index) => (
          <div key={index} className="rounded-lg border border-border/30 bg-background/80 p-2 shadow-sm">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Item {index + 1}
            </div>
            <KnowledgeValue value={item} depth={depth + 1} />
          </div>
        ))}
        {remaining > 0 && (
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">+{remaining} more</div>
        )}
      </div>
    );
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length === 0) {
      return <span className="text-muted-foreground italic">Empty object</span>;
    }

    return (
      <div className={cn('space-y-2', depth > 0 && 'border-l border-border/30 pl-3')}>
        {entries.map(([key, val]) => (
          <div key={key} className="flex items-start gap-3">
            <span className="min-w-[96px] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {key}
            </span>
            <div className="flex-1">
              <KnowledgeValue value={val} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return <span className="font-mono text-[12px] break-words">{formatPrimitive(value)}</span>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function formatPrimitive(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
