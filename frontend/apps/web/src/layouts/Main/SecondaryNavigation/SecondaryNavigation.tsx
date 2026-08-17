import type { ReactNode } from 'react';

import { Collapsible, Tooltip, cn } from '@ci/shadcn';
import {
  BookOpen,
  Brain,
  Cable,
  CalendarRange,
  ChartColumn,
  ChevronRight,
  Download,
  LifeBuoy,
  Inbox,
  ListTodo,
  MessagesSquare,
  NotebookPen,
  FolderSearch2,
  Workflow,
} from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';

import { usePowerRail } from '../PowerRailContext';
import { NavUser } from '../PrimaryNavigation/NavUser';

import { NavLink } from './NavLink';
import { useFeedBadgeCount } from './useFeedBadgeCount';

interface ExternalNavLinkProps {
  href: string;
  label: string;
  children: ReactNode;
}

function ExternalNavLink({ href, label, children }: ExternalNavLinkProps) {
  const { expanded } = usePowerRail();

  const link = (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={cn(
        'relative rounded-md transition will-change-transform hover:bg-accent hover:text-accent-foreground active:scale-95',
        expanded ? 'flex items-center gap-3 px-2 py-2' : 'p-2',
      )}
    >
      {children}
      {expanded && <span className="truncate text-sm">{label}</span>}
    </a>
  );

  if (expanded) {
    return link;
  }

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>{link}</Tooltip.Trigger>
      <Tooltip.Content side="right">{label}</Tooltip.Content>
    </Tooltip>
  );
}

function RailGroupLabel({ children }: { children: ReactNode }) {
  const { expanded } = usePowerRail();

  if (!expanded) {
    return null;
  }

  return (
    <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-1">
      {children}
    </div>
  );
}

function SourcesSubmenu() {
  const { expanded } = usePowerRail();
  const { isFeatureEnabled } = useFeatures();

  if (!expanded) {
    return (
      <NavLink to="/sources" label="Sources" end={false}>
        <Cable className="h-6 w-6 shrink-0" strokeWidth={1.25} />
      </NavLink>
    );
  }

  return (
    <Collapsible defaultOpen className="flex flex-col">
      <div className="flex items-center">
        <NavLink to="/sources" label="Sources" end={false} className="flex-1">
          <Cable className="h-6 w-6 shrink-0" strokeWidth={1.25} />
        </NavLink>
        <Collapsible.Trigger
          aria-label="Sources submenu"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground [&[data-state=open]>svg]:rotate-90"
        >
          <ChevronRight className="h-4 w-4 transition-transform" />
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content>
        <div className="ml-5 flex flex-col border-l border-border/70 pl-2">
          <NavLink to="/sources/connect" label="Connect">
            <Cable className="h-4 w-4 shrink-0" strokeWidth={1.25} />
          </NavLink>
          {isFeatureEnabled('import.page') && (
            <NavLink to="/sources/import" label="Import">
              <Download className="h-4 w-4 shrink-0" strokeWidth={1.25} />
            </NavLink>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible>
  );
}

export function SecondaryNavigation() {
  const { expanded, setHovered } = usePowerRail();
  const { isFeatureEnabled } = useFeatures();
  const feedBadgeCount = useFeedBadgeCount();

  return (
    <nav
      id="power-rail"
      // Hover expands it, the way it did in early versions — the pin is for
      // keeping it that way. `onFocus`/`onBlur` with capture so tabbing into a
      // collapsed rail reveals the labels too; a keyboard user gets the same
      // affordance a pointer does.
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setHovered(false);
        }
      }}
      data-state={expanded ? 'expanded' : 'collapsed'}
      className={cn(
        'flex h-full flex-col overflow-x-hidden p-2 transition-[width] duration-200',
        expanded ? 'w-56' : 'w-14',
      )}
    >
      <Tooltip.Provider>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          <RailGroupLabel>Main</RailGroupLabel>
          <div className="flex flex-col gap-1">
            <NavLink to="/feed" label="Feed" badgeCount={feedBadgeCount}>
              <Inbox className="h-6 w-6 shrink-0" strokeWidth={1.25} />
            </NavLink>

            {isFeatureEnabled('schedule.page') && (
              <NavLink to="/schedule" label="Schedule">
                <CalendarRange className="h-6 w-6 shrink-0" strokeWidth={1.25} />
              </NavLink>
            )}

            <NavLink to="/memory" label="Memory">
              <Brain className="h-6 w-6 shrink-0" strokeWidth={1.25} />
            </NavLink>

            {isFeatureEnabled('chat.page') && (
              <NavLink to="/chat" label="Chat">
                <MessagesSquare className="h-6 w-6 shrink-0" strokeWidth={1.25} />
              </NavLink>
            )}

            {isFeatureEnabled('planning.page') && (
              <NavLink to="/plan" label="Plan">
                <ListTodo className="h-6 w-6 shrink-0" strokeWidth={1.25} />
              </NavLink>
            )}
          </div>

          <RailGroupLabel>More</RailGroupLabel>
          <div className="flex flex-col gap-1">
            <NavLink to="/saved-searches" label="Saved Searches">
              <FolderSearch2 className="h-6 w-6 shrink-0" strokeWidth={1.25} />
            </NavLink>

            {isFeatureEnabled('stats.page') && (
              <NavLink to="/stats" label="Stats">
                <ChartColumn className="h-6 w-6 shrink-0" strokeWidth={1.25} />
              </NavLink>
            )}

            <NavLink to="/notes" label="Notes" end={false}>
              <NotebookPen className="h-6 w-6 shrink-0" strokeWidth={1.25} />
            </NavLink>

            {/* Getting data in belongs in the rail that lists what the app is
                FOR, not in the account dropdown next to Settings and Log out —
                that is a menu you open to change a setting, not to add data.
                `end={false}` so both halves of Sources light it up. Not
                flag-gated: the route is not either, and the connect half exists
                whatever `import.page` says. */}
            <SourcesSubmenu />

            {isFeatureEnabled('jobs.page') && (
              <NavLink to="/jobs" label="Jobs">
                <Workflow className="h-6 w-6 shrink-0" strokeWidth={1.25} />
              </NavLink>
            )}
          </div>
        </div>

        <div className="mt-auto flex flex-col gap-1 pb-2">
          <ExternalNavLink href="https://ci.computer/support" label="Support">
            <LifeBuoy className="h-6 w-6 shrink-0" strokeWidth={1.25} />
          </ExternalNavLink>

          <ExternalNavLink
            href="https://docs.ci.computer/docs/first-party-apps/digital-memory-server"
            label="Docs"
          >
            <BookOpen className="h-6 w-6 shrink-0" strokeWidth={1.25} />
          </ExternalNavLink>

          <NavUser />
        </div>
      </Tooltip.Provider>
    </nav>
  );
}
