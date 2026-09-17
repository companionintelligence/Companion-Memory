import { useRef, useState, type ReactNode } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Tabs, cn } from '@ci/shadcn';

import { withAllColumns, type Section, type SectionedTask } from './taskSections';

function OverdueHint({ count, className }: { count: number; className?: string }) {
  if (count <= 0) {
    return null;
  }

  return (
    <span className={cn('font-normal normal-case tracking-normal text-destructive', className)}>
      {count} overdue
    </span>
  );
}

interface ColumnProps<T extends SectionedTask> {
  section: Section<T>;
  renderTask: (task: T) => ReactNode;
  /** Skip the column heading when the surrounding tabs already name it. */
  showHeading?: boolean;
  className?: string;
}

function TaskColumn<T extends SectionedTask>({
  section,
  renderTask,
  showHeading = true,
  className,
}: ColumnProps<T>) {
  const { isMobile } = useDeviceLayout();
  const overdue = section.overdueCount;

  return (
    <section className={cn('flex min-h-0 min-w-[11rem] flex-col', className)}>
      {showHeading ? (
        <h2 className="shrink-0 px-1 pb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {section.label}
          <span className="ml-2 font-normal">{section.count}</span>
          <OverdueHint count={overdue} className="ml-2" />
        </h2>
      ) : (
        <OverdueHint count={overdue} className="px-1 pb-2 text-xs" />
      )}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto',
          isMobile ? 'gap-2' : 'gap-3',
          // Phone: space after the last card so the list end is obvious and
          // the home indicator does not cover it.
          isMobile && 'pb-[calc(1.5rem+var(--safe-area-bottom))]',
        )}
        data-list-scroll=""
      >
        {section.lanes.map((lane) => (
          <div key={lane.key} className="flex flex-col gap-2">
            {lane.label ? (
              <h3
                className={cn(
                  'shrink-0 px-1 text-xs font-semibold uppercase tracking-wide',
                  lane.key === 'overdue' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {lane.label}
                <span className="ml-2 font-normal">{lane.count}</span>
              </h3>
            ) : null}
            <ul className="flex flex-col gap-2">{lane.tasks.map((task) => renderTask(task))}</ul>
          </div>
        ))}
      </div>
    </section>
  );
}

interface Props<T extends SectionedTask> {
  sections: Section<T>[];
  renderTask: (task: T) => ReactNode;
  tab?: string | null;
  onTabChange?: (tab: string) => void;
}

export function TaskBoard<T extends SectionedTask>({
  sections,
  renderTask,
  tab: tabProp,
  onTabChange,
}: Props<T>) {
  const { isMobile } = useDeviceLayout();
  const [uncontrolledTab, setUncontrolledTab] = useState<string | null>(null);
  const tab = tabProp !== undefined ? tabProp : uncontrolledTab;
  const setTab = onTabChange ?? setUncontrolledTab;
  const columns = withAllColumns(sections);
  const resolved = useRef<string | null>(null);

  // First paint is SSR-safe (`isMobile` is undefined). Wait rather than
  // flashing four columns onto a phone.
  if (isMobile == null) {
    return null;
  }

  /**
   * ═══ THE TAB USED TO MOVE UNDER THE USER ═══
   *
   * `firstKey` was recomputed every render and used whenever the owner had not
   * set a tab — which is most of the time, since only an explicit tap and Plan
   * set one. Emptying the visible column (Dismiss on the last Proposed card)
   * therefore swapped the pane to a column nobody had chosen. Remember the
   * resolved key instead, and only start remembering once the board has
   * something in it, so a board that loads empty still picks a sensible default
   * when its tasks arrive.
   */
  const firstKey = columns.find((section) => section.count > 0)?.key ?? columns[0]?.key;
  const activeTab = columns.some((section) => section.key === tab) ? tab! : (resolved.current ?? firstKey);

  if (activeTab && columns.some((section) => section.count > 0)) {
    resolved.current = activeTab;
  }

  if (isMobile) {
    if (!activeTab) {
      return null;
    }

    return (
      <Tabs value={activeTab} onValueChange={setTab} className="flex h-full min-h-0 flex-1 flex-col gap-2">
        <Tabs.List className="h-auto max-w-full justify-start overflow-x-auto">
          {columns.map((section) => (
            <Tabs.Trigger key={section.key} value={section.key} className="shrink-0">
              {section.label}
              <span className="ml-2 font-normal">{section.count}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {columns.map((section) => (
          <Tabs.Content key={section.key} value={section.key} className="min-h-0 flex-1 overflow-hidden">
            <TaskColumn section={section} renderTask={renderTask} showHeading={false} className="h-full" />
          </Tabs.Content>
        ))}
      </Tabs>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 gap-3 overflow-x-auto">
      {columns.map((section) => (
        <TaskColumn
          key={section.key}
          section={section}
          renderTask={renderTask}
          className="min-w-[11rem] flex-1 rounded-lg border border-border bg-muted/30 px-2 py-2"
        />
      ))}
    </div>
  );
}
