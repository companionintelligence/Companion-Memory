import type { ReactNode } from 'react';

import { Tooltip } from '@ci/shadcn';
import {
  BookOpen,
  Brain,
  LifeBuoy,
  Inbox,
  Lightbulb,
  MessagesSquare,
  Package,
  HardDrive,
  NotebookPen,
  FolderSearch2,
} from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';

import { NavLink } from './NavLink';
import { useFeedBadgeCount } from './useFeedBadgeCount';

interface ExternalNavLinkProps {
  href: string;
  label: string;
  children: ReactNode;
}

function ExternalNavLink({ href, label, children }: ExternalNavLinkProps) {
  return (
    <Tooltip>
      <Tooltip.Trigger asChild>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
          className="relative rounded-md p-2 transition will-change-transform hover:bg-accent hover:text-accent-foreground active:scale-95"
        >
          {children}
        </a>
      </Tooltip.Trigger>
      <Tooltip.Content side="right">{label}</Tooltip.Content>
    </Tooltip>
  );
}

export function SecondaryNavigation() {
  const { isFeatureEnabled } = useFeatures();
  const feedBadgeCount = useFeedBadgeCount();

  return (
    <nav className="flex h-full flex-col p-2">
      <Tooltip.Provider>
        <div className="flex flex-col gap-2">
          <NavLink to="/feed" label="Feed" badgeCount={feedBadgeCount}>
            <Inbox className="h-6 w-6" strokeWidth={1.25} />
          </NavLink>

          <NavLink to="/memory" label="Memory">
            <Brain className="h-6 w-6" strokeWidth={1.25} />
          </NavLink>

          {isFeatureEnabled('insights.page') && (
            <NavLink to="/insights" label="Insights">
              <Lightbulb className="h-6 w-6" strokeWidth={1.25} />
            </NavLink>
          )}

          {isFeatureEnabled('chat.page') && (
            <NavLink to="/chat" label="Chat">
              <MessagesSquare className="h-6 w-6" strokeWidth={1.25} />
            </NavLink>
          )}

          <NavLink to="/saved-searches" label="Saved Searches">
            <FolderSearch2 className="h-6 w-6" strokeWidth={1.25} />
          </NavLink>

          <NavLink to="/notes" label="Notes" end={false}>
            <NotebookPen className="h-6 w-6" strokeWidth={1.25} />
          </NavLink>

          {isFeatureEnabled('enable.inventory.page') && (
            <NavLink to="/inventory" label="Inventory">
              <Package className="h-6 w-6" strokeWidth={1.25} />
            </NavLink>
          )}

          {isFeatureEnabled('files.page') && (
            <NavLink to="/files" label="Files">
              <HardDrive className="h-6 w-6" strokeWidth={1.25} />
            </NavLink>
          )}
        </div>

        <div className="mt-auto flex flex-col gap-2 pb-2">
          <ExternalNavLink href="https://ci.computer/support" label="Support">
            <LifeBuoy className="h-6 w-6" strokeWidth={1.25} />
          </ExternalNavLink>

          <ExternalNavLink
            href="https://docs.ci.computer/docs/first-party-apps/digital-memory-server"
            label="Docs"
          >
            <BookOpen className="h-6 w-6" strokeWidth={1.25} />
          </ExternalNavLink>
        </div>
      </Tooltip.Provider>
    </nav>
  );
}
