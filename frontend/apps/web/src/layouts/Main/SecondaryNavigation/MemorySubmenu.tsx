import { Fragment, useState } from 'react';

import { cn } from '@ci/shadcn';
import { Brain, ChevronRight } from '@ci/shadcn/icons';
import { useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { MEMORY_HUB_SECTIONS, isMemoryHubPath } from '@/components/MemoryHub/memoryHubSections';
import { CHAT_BASE, chatThreadPath } from '@/pages/ChatPage/chatPaths';
import type { Thread } from '@/pages/ChatPage/types';
import { threadLabel, useRecentThreads } from '@/pages/ChatPage/useRecentThreads';

import { usePowerRail } from '../PowerRailContext';

import { RAIL_LEAF_HEIGHT, RAIL_LEAF_INSET, railRowTone } from './railRow';
import { RailSubmenuHead, RailSubmenuLeaf, RailSubmenuRow, RailSubmenuShell } from './RailSubmenuShell';
import { useRailSubmenuOpen } from './useRailSubmenuOpen';

/**
 * How many recent threads Chat shows before "All chats". Three is enough to
 * get back into what you were just doing; the rest of the list stays one tap
 * away instead of pushing Saved Searches and Sources off the screen.
 */
const RAIL_THREAD_PREVIEW = 3;

/**
 * Chat's recent threads, one level under Chat.
 *
 * "All chats" opens the rest of the list in place rather than linking to the
 * Chat page: on a phone that page is a composer, not a list (its sidebar
 * portals to a slot the phone layout never renders), so this list is the only
 * way to reach an older thread there.
 *
 * The thread you are in always shows, even when it is older than the preview.
 */
function RecentThreads({
  threads,
  loading,
  pathname,
}: {
  threads: Thread[];
  loading: boolean;
  pathname: string;
}) {
  const [showAll, setShowAll] = useState(false);

  if (threads.length === 0) {
    return loading ? (
      <span
        className={cn('flex items-center text-xs text-muted-foreground', RAIL_LEAF_HEIGHT, RAIL_LEAF_INSET)}
      >
        Loading threads…
      </span>
    ) : null;
  }

  const current = threads.find((thread) => pathname === chatThreadPath(thread.id));
  const preview = threads.slice(0, RAIL_THREAD_PREVIEW);
  const folded = current && !preview.includes(current) ? [...preview, current] : preview;
  const shown = showAll ? threads : folded;

  return (
    <>
      {shown.map((thread) => {
        const to = chatThreadPath(thread.id);

        return (
          <RailSubmenuLeaf key={thread.id} to={to} label={threadLabel(thread)} active={pathname === to} />
        );
      })}

      {threads.length > RAIL_THREAD_PREVIEW ? (
        // Says what a tap will do, like "Show more" / "Show less", so its name
        // changes with the list rather than carrying an expanded state.
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className={cn(
            'flex items-center gap-1.5 rounded-md text-left text-xs font-medium text-primary transition',
            RAIL_LEAF_HEIGHT,
            RAIL_LEAF_INSET,
            railRowTone(false),
            'hover:text-primary',
          )}
        >
          {showAll ? 'Fewer chats' : 'All chats'}
          <ChevronRight
            aria-hidden
            className={cn('h-3.5 w-3.5 shrink-0 transition-transform duration-200', showAll && '-rotate-90')}
          />
        </button>
      ) : null}
    </>
  );
}

/**
 * Power Rail Memory entry with hub section children.
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
  const routeOpen = isMemoryHubPath(pathname);
  const { open, clickOpen, onOpenChange, onHeadClick } = useRailSubmenuOpen('memory', routeOpen);

  // Idle until the group is actually showing its contents — the rail renders
  // on every page, so an eager thread list would be a request per navigation
  // for a menu nobody opened. Collapsed icon stacks use clickOpen; the
  // expanded accordion uses open (route or click) only while the rail is wide.
  // Threads themselves are labels, so they stay off the collapsed stack.
  const { threads, loading: threadsLoading } = useRecentThreads({
    enabled: expanded && open,
  });

  const visible = MEMORY_HUB_SECTIONS.filter((section) => !section.flag || isFeatureEnabled(section.flag));
  const memoryIcon = <Brain className="h-6 w-6 shrink-0" strokeWidth={1.25} />;

  return (
    <RailSubmenuShell
      to="/memory"
      ariaLabel="Memory"
      chevronLabel="Memory"
      routeOpen={routeOpen}
      open={open}
      clickOpen={clickOpen}
      onOpenChange={onOpenChange}
      onHeadClick={onHeadClick}
      testId="memory-submenu"
      collapsedIcon={memoryIcon}
      head={<RailSubmenuHead icon={memoryIcon} label="Memory" />}
    >
      {visible.map((section) => {
        const Icon = section.icon;
        const isChat = section.to === CHAT_BASE;
        // Chat alone has its own nested links here (recent threads) — an
        // exact match, not section.match's thread-inclusive one, so a
        // specific open thread owns "current", not both it and the Chat row
        // above it. Every other section has no nested rail links competing
        // for aria-current, so the broader matcher (which does need to cover
        // e.g. /memory/content/:fileId) is correct for them.
        const active = isChat ? pathname === CHAT_BASE : section.match(pathname);

        return (
          <Fragment key={section.to}>
            <RailSubmenuRow
              to={section.to}
              label={section.label}
              active={active}
              icon={
                <span className="[&>svg]:!h-4 [&>svg]:!w-4">
                  <Icon colorized={false} className="dark:text-muted-foreground" />
                </span>
              }
            />

            {isChat && expanded && (
              <RecentThreads threads={threads} loading={threadsLoading} pathname={pathname} />
            )}
          </Fragment>
        );
      })}
    </RailSubmenuShell>
  );
}
