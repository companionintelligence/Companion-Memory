import { Fragment, useEffect, useState } from 'react';

import { Collapsible, Tooltip, cn } from '@ci/shadcn';
import { Brain, ChevronRight, MessageSquare } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { MEMORY_HUB_SECTIONS, isMemoryHubPath } from '@/components/MemoryHub/memoryHubSections';
import { CHAT_BASE } from '@/pages/ChatPage/chatPaths';
import { threadLabel, useRecentThreads } from '@/pages/ChatPage/useRecentThreads';

import { usePowerRail } from '../PowerRailContext';

/**
 * Power Rail Memory entry with hub section children.
 *
 * Open = sticky click, hub route, or hover — unless the user explicitly closed
 * it (chevron), which suppresses hover/route until they leave or reopen.
 *
 * Chat's recent threads render nested under its own row here (moved from the
 * old, now-removed ChatSubmenu) — the phone drawer is the only way to change
 * conversation there, since `ChatSidebar` portals to `tertiary-navigation`, a
 * slot the mobile layout never renders.
 */
export function MemorySubmenu() {
  const { expanded } = usePowerRail();
  const { pathname } = useLocation();
  const { isFeatureEnabled } = useFeatures();
  const [stickyOpen, setStickyOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  /** User closed via chevron — ignore hover/route until mouse leave or reopen. */
  const [dismissed, setDismissed] = useState(false);

  const routeOpen = isMemoryHubPath(pathname);
  const memoryRootActive = pathname === '/memory';
  const open = dismissed ? false : stickyOpen || routeOpen || hoverOpen;

  // Idle until the group is actually showing its contents — same reasoning
  // ChatSubmenu had: the rail renders on every page, so an eager thread list
  // would be a request per navigation for a menu nobody opened.
  const { threads, loading: threadsLoading } = useRecentThreads({ enabled: open && expanded });

  const visible = MEMORY_HUB_SECTIONS.filter((section) => !section.flag || isFeatureEnabled(section.flag));

  // New hub page → allow auto-open again.
  useEffect(() => {
    setDismissed(false);
  }, [pathname]);

  if (!expanded) {
    const collapsed = (
      <Link
        to="/memory"
        aria-label="Memory"
        className={cn(
          'relative rounded-md border-l-2 border-transparent p-2 transition hover:bg-accent hover:text-accent-foreground',
          routeOpen && 'border-l-primary text-primary hover:text-primary',
        )}
      >
        <Brain className="h-6 w-6 shrink-0" strokeWidth={1.25} />
      </Link>
    );

    return (
      <Tooltip>
        <Tooltip.Trigger asChild>{collapsed}</Tooltip.Trigger>
        <Tooltip.Content side="right">Memory</Tooltip.Content>
      </Tooltip>
    );
  }

  return (
    <div
      data-testid="memory-submenu"
      className="min-w-0 w-full overflow-hidden"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => {
        setHoverOpen(false);
        setDismissed(false);
      }}
    >
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setStickyOpen(true);
            setDismissed(false);
          } else {
            setStickyOpen(false);
            setDismissed(true);
          }
        }}
        className="min-w-0 w-full"
      >
        {/* One row: Memory + chevron share the same box (same geometry as NavLink). */}
        <div
          className={cn(
            'flex min-w-0 w-full items-center rounded-md border-l-2 border-transparent',
            memoryRootActive && 'border-l-primary text-primary',
          )}
        >
          <Link
            to="/memory"
            aria-label="Memory"
            aria-current={memoryRootActive ? 'page' : undefined}
            onClick={() => {
              setStickyOpen(true);
              setDismissed(false);
            }}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-3 rounded-l-md px-2 py-2 transition hover:bg-accent hover:text-accent-foreground',
              memoryRootActive && 'text-primary hover:text-primary',
            )}
          >
            <Brain className="h-6 w-6 shrink-0" strokeWidth={1.25} />
            <span className="truncate text-sm">Memory</span>
          </Link>
          <Collapsible.Trigger
            className="flex shrink-0 items-center self-stretch rounded-r-md px-2 transition hover:bg-accent hover:text-accent-foreground [&[data-state=open]>svg]:rotate-90"
            aria-label={open ? 'Collapse Memory sections' : 'Expand Memory sections'}
          >
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform" />
          </Collapsible.Trigger>
        </div>

        <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="flex min-w-0 flex-col">
            {visible.map((section) => {
              const Icon = section.icon;
              const isChat = section.to === CHAT_BASE;
              // Chat alone has its own nested links here (recent threads) —
              // an exact match, not section.match's thread-inclusive one, so
              // a specific open thread owns "current", not both it and the
              // Chat row above it. Every other section has no nested rail
              // links competing for aria-current, so the broader matcher
              // (which does need to cover e.g. /memory/content/:fileId) is
              // correct for them.
              const active = isChat ? pathname === CHAT_BASE : section.match(pathname);

              return (
                <Fragment key={section.to}>
                  <Link
                    to={section.to}
                    aria-label={section.label}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-0 text-sm leading-tight transition hover:bg-accent hover:text-accent-foreground',
                      active && 'border-l-primary text-primary hover:text-primary',
                    )}
                  >
                    <span
                      className="grid size-6 shrink-0 place-items-center [&>svg]:!h-4 [&>svg]:!w-4"
                      aria-hidden
                    >
                      <Icon colorized={false} className="dark:text-muted-foreground" />
                    </span>
                    <span className="truncate">{section.label}</span>
                  </Link>

                  {isChat && (
                    <>
                      {threads.length > 0 && (
                        <span className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Recent
                        </span>
                      )}

                      {threads.map((thread) => {
                        const to = `${CHAT_BASE}/${thread.id}`;
                        const threadActive = pathname === to;
                        const label = threadLabel(thread);

                        return (
                          <Link
                            key={thread.id}
                            to={to}
                            aria-label={label}
                            aria-current={threadActive ? 'page' : undefined}
                            className={cn(
                              'flex min-w-0 items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-0 text-sm leading-tight transition hover:bg-accent hover:text-accent-foreground',
                              threadActive && 'border-l-primary text-primary hover:text-primary',
                            )}
                          >
                            <span className="grid size-6 shrink-0 place-items-center" aria-hidden>
                              <MessageSquare className="h-4 w-4 text-muted-foreground" strokeWidth={1.25} />
                            </span>
                            <span className="truncate">{label}</span>
                          </Link>
                        );
                      })}

                      {threadsLoading && threads.length === 0 && (
                        <span className="px-2 py-1 text-xs text-muted-foreground">Loading threads…</span>
                      )}
                    </>
                  )}
                </Fragment>
              );
            })}
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  );
}
