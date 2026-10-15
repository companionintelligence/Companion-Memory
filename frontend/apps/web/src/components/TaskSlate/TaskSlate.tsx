import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';

import { useMutation } from '@apollo/client';
import { useDeviceLayout } from '@ci/common';
import { Button, cn, IconButton, Sheet, Tabs, Tooltip } from '@ci/shadcn';
import { Plus, X } from '@ci/shadcn/icons';

import { usePlaceLookup } from '@/api/usePlaceLookup';
import {
  EVENT_DRAFT_PROBLEM_MESSAGES,
  EventForm,
  eventDraftAt,
  eventDraftToInput,
  validateEventDraft,
  type EventDraft,
  type EventDraftProblem,
} from '@/components/EventForm';
import type { CalendarSlot } from '@/components/HorizonGrid';
import { formatClock } from '@/components/HorizonGrid/nowNext';
import { gql } from '@/graphql';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';
import { type Section } from '@/pages/PlanPage/taskSections';
import type { PlanTask } from '@/pages/PlanPage/usePlanTasks';

const CREATE_EVENT = gql(`
  mutation CreateEvent($input: CreateEventInput!) {
    createEvent(input: $input) {
      id
      title
      description
      startTime
      endTime
      eventType
      locationName
    }
  }
`);

function formatDue(dueAt: string | Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(dueAt));
}

interface CardProps {
  task: PlanTask;
  /** Proposed inbox items can be declined; unscheduled work is only placed. */
  onDismiss?: (id: string) => void;
  /** Click the card to put it on the selected slot. */
  onPlace?: (id: string) => void;
}

/**
 * A possibility, waiting.
 *
 * ═══ WHAT THIS USED TO DO ═══
 * Carry a whole drag subsystem — HTML5 `dragstart` on a mouse, a hold-to-drag
 * pointer protocol on touch, and a six-dot handle to start it — so a card could
 * be dropped on a day. #2529 replaced that with clicking an empty slot, and
 * nothing has rendered a draggable card since; the machinery stayed, unreachable
 * on every device, while its comments still promised drag-to-place worked.
 */
function BacklogCard({ task, onDismiss, onPlace }: CardProps) {
  const proposed = task.status === 'proposed' || Boolean(task.hasPendingChange);

  return (
    <li
      onClick={onPlace ? () => onPlace(task.id) : undefined}
      onKeyDown={
        onPlace
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onPlace(task.id);
              }
            }
          : undefined
      }
      role={onPlace ? 'button' : undefined}
      tabIndex={onPlace ? 0 : undefined}
      aria-label={onPlace ? `Add ${task.title} at this time` : undefined}
      className={cn(
        'group relative flex flex-col rounded-lg border border-border bg-background',
        'p-2.5 pl-2.5 pr-9 transition-colors',
        onPlace && 'cursor-pointer hover:border-primary/50',
      )}
    >
      <p className="text-[13px] leading-snug text-foreground">{task.title}</p>

      {onDismiss && proposed ? (
        <div
          className={cn(
            'absolute bottom-1.5 right-2.5 z-10 flex items-center rounded-md',
            'border border-border/60 bg-background/95 px-0.5 shadow-sm backdrop-blur-sm',
            'pointer-events-none opacity-0 transition-opacity',
            'group-hover:pointer-events-auto group-hover:opacity-100',
            'focus-within:pointer-events-auto focus-within:opacity-100',
            'pointer-coarse:pointer-events-auto pointer-coarse:opacity-100',
          )}
        >
          <Tooltip>
            <Tooltip.Trigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 pointer-coarse:h-8 pointer-coarse:w-8"
                aria-label={`Dismiss ${task.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDismiss(task.id);
                }}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content side="top">Dismiss</Tooltip.Content>
          </Tooltip>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-1 pt-1.5">
        {proposed ? (
          <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">proposed</span>
        ) : null}
        {task.dueAt ? (
          <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            Due {formatDue(task.dueAt)}
          </span>
        ) : null}
        {task.estimatedMinutes ? (
          <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground tabular-nums">
            {task.estimatedMinutes}m
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * What this rail actually puts on screen, and what it leaves to Plan.
 *
 * `section.count` / `section.overdueCount` are subtree-aware: right for the
 * Plan board, which renders every child nested under its root, wrong here,
 * where only roots get a card. Borrowing them printed a "3" over a list of
 * one. Roots are all this surface can attribute — a `Section` carries the
 * subtree's size but not its rows — so the badge counts the cards and the
 * remainder is named (see `NestedNote`) rather than left looking like a bug.
 *
 * A root sits in the Overdue lane exactly when `isOverdue` holds for it, so
 * whatever overdue the section counts beyond that lane is a hidden child.
 */
function listedInSlate(section: Section<PlanTask>) {
  const count = section.tasks.length;
  const overdueCount = section.lanes.find((lane) => lane.key === 'overdue')?.tasks.length ?? 0;

  return {
    count,
    overdueCount,
    nested: section.count - count,
    nestedOverdue: section.overdueCount - overdueCount,
  };
}

/**
 * "Plan nests 2 subtasks under these" — the board's number, minus this list.
 *
 * `nested` counts finished descendants too, and it has to: a `Section` carries
 * the subtree's size but not its rows, so a done child is indistinguishable
 * from a live one from here. "2 nested subtasks" therefore promised
 * outstanding work in a rail titled Possibilities even when the only child was
 * ticked off, so the line says what the number actually spans instead.
 *
 * `nestedOverdue` comes from `overdueCount`, which is status-aware — finished
 * work is never overdue — so that clause can still be stated flatly.
 */
function NestedNote({ nested, nestedOverdue }: { nested: number; nestedOverdue: number }) {
  if (nested <= 0) {
    return null;
  }

  return (
    <p className="px-1 pb-2 text-[11px] leading-snug text-muted-foreground">
      Plan nests {nested} {nested === 1 ? 'subtask' : 'subtasks'} under these, done or not
      {nestedOverdue > 0 ? <span className="text-destructive"> · {nestedOverdue} overdue</span> : null}
    </p>
  );
}

function BacklogColumn({
  section,
  onDismiss,
  showHeading = true,
  onPlace,
}: {
  section: Section<PlanTask>;
  onDismiss?: (id: string) => void;
  showHeading?: boolean;
  onPlace?: (id: string) => void;
}) {
  const { count, overdueCount: overdue, nested, nestedOverdue } = listedInSlate(section);
  const dismiss = section.key === 'proposed' ? onDismiss : undefined;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {showHeading ? (
        <h4 className="shrink-0 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {section.label}
          <span className="ml-2 font-normal">{count}</span>
          {overdue > 0 ? (
            <span className="ml-2 font-normal normal-case tracking-normal text-destructive">
              {overdue} overdue
            </span>
          ) : null}
        </h4>
      ) : overdue > 0 ? (
        <p className="px-1 pb-2 text-xs text-destructive">{overdue} overdue</p>
      ) : null}

      <NestedNote nested={nested} nestedOverdue={nestedOverdue} />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-list-scroll="">
        {section.lanes.map((lane) => (
          <div key={lane.key} className="flex flex-col gap-2">
            {lane.label ? (
              <h5
                className={cn(
                  'shrink-0 px-1 text-[11px] font-semibold uppercase tracking-wide',
                  lane.key === 'overdue' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {lane.label}
                <span className="ml-2 font-normal">{lane.tasks.length}</span>
              </h5>
            ) : null}
            <ul className="flex flex-col gap-2">
              {lane.tasks.map((task) => (
                <BacklogCard key={task.id} task={task} onDismiss={dismiss} onPlace={onPlace} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

interface SlateBodyProps {
  sections: Section<PlanTask>[];
  loading: boolean;
  /**
   * The Plan list could not be fetched. Distinct from an empty slate, and it
   * has to be: "nothing waiting yet" is a claim about the user's life, and
   * making it on the strength of a failed request is a lie.
   */
  error?: boolean;
  onDismissProposed?: (id: string) => void;
  onPlace?: (id: string) => void;
}

/** The empty/loading/error copy and the backlog columns, behind a tablist. */
function SlateBody({ sections, loading, error = false, onDismissProposed, onPlace }: SlateBodyProps) {
  const [tab, setTab] = useState<string | null>(null);
  const hasCards = sections.some((section) => section.tasks.length > 0);
  const firstKey = sections[0]?.key;
  const activeTab = sections.some((section) => section.key === tab) ? tab! : firstKey;

  return (
    <>
      {loading && !hasCards ? (
        <p className="self-start text-[12px] text-muted-foreground">Loading your plan…</p>
      ) : null}

      {!loading && !hasCards && error ? (
        <p role="alert" className="max-w-md self-start text-[12px] leading-relaxed text-destructive">
          Could not load your plan. Try again shortly.
        </p>
      ) : null}

      {!loading && !hasCards && !error ? (
        <p className="max-w-md self-start text-[12px] leading-relaxed text-muted-foreground">
          Nothing in Proposed or Unscheduled. Add a task on the Plan page and it will show up here.
        </p>
      ) : null}

      {hasCards && activeTab ? (
        <Tabs value={activeTab} onValueChange={setTab} className="flex min-h-0 flex-col gap-3">
          <Tabs.List className="h-auto max-w-full justify-start overflow-x-auto">
            {sections.map((section) => {
              const listed = listedInSlate(section);

              return (
                <Tabs.Trigger key={section.key} value={section.key} className="shrink-0">
                  {section.label}
                  <span className="ml-2 font-normal">{listed.count}</span>
                  {listed.overdueCount > 0 ? (
                    <span className="ml-2 font-normal text-destructive">{listed.overdueCount} overdue</span>
                  ) : null}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>

          {sections.map((section) => (
            <Tabs.Content key={section.key} value={section.key} className="min-h-0">
              <BacklogColumn
                section={section}
                onDismiss={onDismissProposed}
                showHeading={false}
                onPlace={onPlace}
              />
            </Tabs.Content>
          ))}
        </Tabs>
      ) : null}
    </>
  );
}

/**
 * "Wednesday, Sep 30 · 3:00 PM". The slot was picked on the grid, which draws in the profile zone,
 * so both halves read the formatter's zone — the day and the hour the person actually clicked.
 */
function formatSlotHeading(slot: CalendarSlot, fmt: DateTimeFormatter): string {
  const day = fmt.date(slot.instant, { weekday: 'long', month: 'short', day: 'numeric' });

  return slot.allDay ? `${day} · All day` : `${day} · ${formatClock(slot.instant, fmt)}`;
}

interface TaskSlateDrawerProps extends SlateBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slot: CalendarSlot | null;
  /** HBPE line for this slot, or null when the model has nothing to say. */
  insight?: string | null;
  onCreated?: () => void;
}

/**
 * The slot you pointed at on the calendar: add a new event there, pick a
 * possibility, or read what Thursdays usually look like.
 *
 * Overlay is see-through and non-modal so another empty click can move the
 * line without closing this. Phone uses the bottom edge so the day stays
 * tappable above it.
 */
export function TaskSlateDrawer({
  open,
  onOpenChange,
  slot,
  sections,
  loading,
  error = false,
  insight = null,
  onDismissProposed,
  onPlace,
  onCreated,
}: TaskSlateDrawerProps) {
  const { isMobile } = useDeviceLayout();
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setOverlayRoot(document.getElementById('overlay-modal'));
  }, []);
  const fmt = useDateTimeFormat();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<EventDraft>(() =>
    eventDraftAt(slot?.instant ?? new Date(), slot?.allDay),
  );
  const [problem, setProblem] = useState<EventDraftProblem | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createEvent, { loading: creating }] = useMutation(CREATE_EVENT);
  const lookupPlace = usePlaceLookup();
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!slot) {
      setComposing(false);
      setProblem(null);
      setSubmitError(null);

      return;
    }

    setDraft((previous) => ({
      ...eventDraftAt(slot.instant, slot.allDay),
      title: previous.title,
      description: previous.description,
    }));
  }, [slot]);

  // The reason lands one line above the buttons, which pushes them below the
  // fold of a sheet the person had scrolled to the very end of. Bring them back
  // into view with it, so Add is still there to press once the problem is fixed.
  useEffect(() => {
    if (problem) {
      actionsRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [problem]);

  /**
   * Leaving the composer takes its failure with it.
   *
   * `submitError` used to be cleared only when `slot` went null, so Cancel then
   * "New event" re-mounted a fresh, untouched form under the alert from the
   * previous attempt — a rejection reported against a write that never happened.
   */
  const closeComposer = () => {
    setComposing(false);
    setProblem(null);
    setSubmitError(null);
  };

  const openComposer = () => {
    setProblem(null);
    setSubmitError(null);
    setComposing(true);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const invalid = validateEventDraft(draft);

    if (invalid) {
      setProblem(invalid);

      return;
    }

    setProblem(null);
    setSubmitError(null);

    try {
      await createEvent({ variables: { input: eventDraftToInput(draft) } });
      onCreated?.();
      setComposing(false);
      setDraft(eventDraftAt(slot?.instant ?? new Date(), slot?.allDay));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to create event.');
    }
  };

  return (
    <Sheet open={open && slot !== null} onOpenChange={onOpenChange} modal={false}>
      <Sheet.Content
        side={isMobile ? 'bottom' : 'right'}
        overlayClassName="bg-transparent pointer-events-none"
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        container={isMobile ? overlayRoot : undefined}
        className={cn(
          'pointer-events-auto gap-0 p-0',
          isMobile
            ? 'max-h-[40vh] w-full overscroll-contain pb-[var(--safe-area-bottom)] sm:max-w-none'
            : 'w-[24rem] sm:max-w-md',
        )}
      >
        <Sheet.Header className="gap-1 pb-1">
          <div className="flex items-start justify-between gap-2 pr-6">
            <div className="min-w-0">
              <Sheet.Title className="text-sm">Add to calendar</Sheet.Title>
              <Sheet.Description className="text-[11px] tabular-nums">
                {slot ? formatSlotHeading(slot, fmt) : 'Pick an empty time'}
              </Sheet.Description>
            </div>
            {!composing && (
              <IconButton
                type="button"
                variant="outline"
                label="New event"
                onClick={openComposer}
                className="h-8 w-8 shrink-0"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
              </IconButton>
            )}
          </div>
        </Sheet.Header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-4">
          <section
            aria-labelledby="slot-predictions-label"
            className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
          >
            <h4
              id="slot-predictions-label"
              className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Predictions
            </h4>
            <p
              className={cn(
                'mt-1 text-[13px] leading-snug',
                insight ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {insight ?? 'No predictions available'}
            </p>
          </section>

          {composing ? (
            <form onSubmit={handleSubmit} className="flex min-h-0 flex-col gap-4">
              <EventForm
                value={draft}
                onChange={setDraft}
                problem={problem}
                disabled={creating}
                lookupPlace={lookupPlace}
              />
              {/* The form scrolls and Add is its last line, so the line EventForm
                  writes beside the offending field is screens above the finger
                  that just pressed Add — which then looked dead. Say it here too,
                  in the slot a rejected write already uses. */}
              {problem ? (
                <p role="alert" className="text-sm text-destructive">
                  {EVENT_DRAFT_PROBLEM_MESSAGES[problem]}
                </p>
              ) : null}
              {submitError ? (
                <p role="alert" className="text-sm text-destructive">
                  {submitError}
                </p>
              ) : null}
              <div ref={actionsRef} className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={closeComposer} disabled={creating}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={creating}>
                  {creating ? 'Adding…' : 'Add'}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div>
                <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Possibilities
                </h4>
                <SlateBody
                  sections={sections}
                  loading={loading}
                  error={error}
                  onDismissProposed={onDismissProposed}
                  onPlace={onPlace}
                />
              </div>
            </>
          )}
        </div>
      </Sheet.Content>
    </Sheet>
  );
}
