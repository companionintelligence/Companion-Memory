import { Fragment } from 'react';

import { Brain, MessageSquare } from '@ci/shadcn/icons';
import { useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { MEMORY_HUB_SECTIONS, isMemoryHubPath } from '@/components/MemoryHub/memoryHubSections';
import { CHAT_BASE } from '@/pages/ChatPage/chatPaths';
import { threadLabel, useRecentThreads } from '@/pages/ChatPage/useRecentThreads';

import { usePowerRail } from '../PowerRailContext';

import { RailSubmenuHead, RailSubmenuRow, RailSubmenuShell } from './RailSubmenuShell';
import { useRailSubmenuOpen } from './useRailSubmenuOpen';

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
  const { open, onOpenChange, onHeadClick } = useRailSubmenuOpen('memory', routeOpen);

  // Idle until the group is actually showing its contents — the rail renders
  // on every page, so an eager thread list would be a request per navigation
  // for a menu nobody opened.
  const { threads, loading: threadsLoading } = useRecentThreads({ enabled: open && expanded });

  const visible = MEMORY_HUB_SECTIONS.filter((section) => !section.flag || isFeatureEnabled(section.flag));
  const memoryIcon = <Brain className="h-6 w-6 shrink-0" strokeWidth={1.25} />;

  return (
    <RailSubmenuShell
      to="/memory"
      ariaLabel="Memory"
      chevronLabel="Memory"
      routeOpen={routeOpen}
      open={open}
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

            {isChat && (
              <>
                {threads.length > 0 && (
                  <span className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Recent
                  </span>
                )}

                {threads.map((thread) => {
                  const to = `${CHAT_BASE}/${thread.id}`;
                  const label = threadLabel(thread);

                  return (
                    <RailSubmenuRow
                      key={thread.id}
                      to={to}
                      label={label}
                      active={pathname === to}
                      icon={<MessageSquare className="h-4 w-4 text-muted-foreground" strokeWidth={1.25} />}
                    />
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
    </RailSubmenuShell>
  );
}
