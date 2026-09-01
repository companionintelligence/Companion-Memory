import { useEffect, useState, type FormEvent } from 'react';

import { useMutation } from '@apollo/client';
import { useDeviceLayout } from '@ci/common';
import { Button, cn, Sheet, Tabs, Tooltip } from '@ci/shadcn';
import { GripVertical, X } from '@ci/shadcn/icons';

import {
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
import { CANDIDATE_DRAG_TYPE } from '@/lib/scheduleDrag';
import { type Section, type SectionedTask } from '@/pages/PlanPage/taskSections';
import type { PlanTask } from '@/pages/PlanPage/usePlanTasks';

import { ScheduleDragGhost } from './ScheduleDragGhost';
import { useCandidatePointerDrag } from './useCandidatePointerDrag';

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

export { CANDIDATE_DRAG_TYPE };

function formatDue(dueAt: string | Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(dueAt));
}

function overdueCount<T extends SectionedTask>(section: Section<T>): number {
  return section.lanes.find((lane) => lane.key === 'overdue')?.tasks.length ?? 0;
}

interface CardProps {
  task: PlanTask;
  /** Proposed inbox items can be declined; unscheduled work is only placed. */
  onDismiss?: (id: string) => void;
  /** Hold-to-drag on touch; desktop keeps HTML5. */
  touchDrag?: boolean;
  /**
   * Whether this card can be dropped onto a day at all.
   *
   * False in the slot drawer — those cards are clicked onto the selected time
   * rather than dragged.
   */
  placeable?: boolean;
  /** Click the card to put it on the selected slot. */
  onPlace?: (id: string) => void;
}

function BacklogCard({ task, onDismiss, touchDrag = false, placeable = true, onPlace }: CardProps) {
  const proposed = task.status === 'proposed' || Boolean(task.hasPendingChange);
  const { onPointerDown, onHandlePointerDown, onContextMenu } = useCandidatePointerDrag(
    task,
    touchDrag && placeable,
  );
  const html5Drag = placeable && !touchDrag;

  return (
    <li
      draggable={html5Drag}
      onDragStart={
        html5Drag
          ? (event) => {
              event.dataTransfer.setData(CANDIDATE_DRAG_TYPE, task.id);
              event.dataTransfer.setData('text/plain', task.title);
              event.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
      onPointerDown={placeable ? onPointerDown : undefined}
      onContextMenu={placeable ? onContextMenu : undefined}
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
        'p-2.5 transition-colors',
        placeable ? 'cursor-grab pl-7 hover:border-primary/50 active:cursor-grabbing' : 'pl-2.5 pr-9',
        onPlace && 'cursor-pointer hover:border-primary/50',
        placeable && touchDrag && 'select-none touch-pan-y [-webkit-touch-callout:none]',
      )}
    >
      {placeable &&
        (touchDrag ? (
          <button
            type="button"
            aria-label={`Drag ${task.title} onto the calendar`}
            className="absolute left-0 top-1 z-10 flex h-11 w-8 touch-none items-start justify-center pt-2 text-muted-foreground"
            onPointerDown={onHandlePointerDown}
            onContextMenu={onContextMenu}
          >
            <GripVertical className="h-4 w-4" strokeWidth={1.5} aria-hidden />
          </button>
        ) : (
          <GripVertical
            className="absolute left-1.5 top-3 h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground pointer-coarse:text-muted-foreground/70"
            strokeWidth={1.5}
            aria-hidden
          />
        ))}

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

function BacklogColumn({
  section,
  onDismiss,
  showHeading = true,
  touchDrag = false,
  placeable = true,
  onPlace,
}: {
  section: Section<PlanTask>;
  onDismiss?: (id: string) => void;
  showHeading?: boolean;
  touchDrag?: boolean;
  placeable?: boolean;
  onPlace?: (id: string) => void;
}) {
  const overdue = overdueCount(section);
  const dismiss = section.key === 'proposed' ? onDismiss : undefined;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {showHeading ? (
        <h4 className="shrink-0 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {section.label}
          <span className="ml-2 font-normal">{section.tasks.length}</span>
          {overdue > 0 ? (
            <span className="ml-2 font-normal normal-case tracking-normal text-destructive">
              {overdue} overdue
            </span>
          ) : null}
        </h4>
      ) : overdue > 0 ? (
        <p className="px-1 pb-2 text-xs text-destructive">{overdue} overdue</p>
      ) : null}

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
                <BacklogCard
                  key={task.id}
                  task={task}
                  onDismiss={dismiss}
                  touchDrag={touchDrag}
                  placeable={placeable}
                  onPlace={onPlace}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

interface TaskSlateProps {
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
  className?: string;
}

interface SlateBodyProps extends Omit<TaskSlateProps, 'className'> {
  /** Undefined until the media query has resolved — neither branch renders. */
  isMobile: boolean | undefined;
  /** Cards can be dragged onto a day. See {@link BacklogCard}. */
  placeable: boolean;
  /** How tall a tab panel may grow: the inline card caps it, the drawer does not. */
  paneClassName: string;
}

/** The empty/loading/error copy and the two columns, wherever they are shown. */
function SlateBody({
  sections,
  loading,
  error = false,
  onDismissProposed,
  onPlace,
  isMobile,
  placeable,
  paneClassName,
}: SlateBodyProps) {
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
          {placeable
            ? 'Nothing in Proposed or Unscheduled. Add a task on the Plan page and it will show up here to drop onto a day.'
            : 'Nothing in Proposed or Unscheduled. Add a task on the Plan page and it will show up here.'}
        </p>
      ) : null}

      {hasCards && isMobile && activeTab ? (
        <Tabs value={activeTab} onValueChange={setTab} className="flex min-h-0 flex-col gap-3">
          <Tabs.List className="h-auto max-w-full justify-start overflow-x-auto">
            {sections.map((section) => (
              <Tabs.Trigger key={section.key} value={section.key} className="shrink-0">
                {section.label}
                <span className="ml-2 font-normal">{section.tasks.length}</span>
                {overdueCount(section) > 0 ? (
                  <span className="ml-2 font-normal text-destructive">{overdueCount(section)} overdue</span>
                ) : null}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          {sections.map((section) => (
            <Tabs.Content key={section.key} value={section.key} className={paneClassName}>
              <BacklogColumn
                section={section}
                onDismiss={onDismissProposed}
                showHeading={false}
                touchDrag
                placeable={placeable}
                onPlace={onPlace}
              />
            </Tabs.Content>
          ))}
        </Tabs>
      ) : null}

      {/* Only ever reached inline — the drawer is a phone surface and passes
          `isMobile` outright, so the rail keeps its own cap. */}
      {hasCards && isMobile === false ? (
        <div className="flex max-h-72 min-h-0 gap-3 overflow-x-auto">
          {sections.map((section) => (
            <div
              key={section.key}
              className="flex min-w-[14rem] flex-1 flex-col rounded-lg border border-border bg-muted/30 px-2 py-2"
            >
              <BacklogColumn
                section={section}
                onDismiss={onDismissProposed}
                placeable={placeable}
                onPlace={onPlace}
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * Proposed and Unscheduled work from Plan — the same two Kanban columns, sitting
 * under the week so a card is a short drag from a day.
 *
 * Scheduled and Done stay on the Plan board. Nothing here places itself; dropping
 * onto a day is the consent that turns a todo into committed time.
 *
 * This is the desktop shape, where there is room beside the week for a rail and
 * a drag across it is a real gesture. A phone gets {@link TaskSlateDrawer}.
 */
export function TaskSlate({
  sections,
  loading,
  error = false,
  onDismissProposed,
  className,
}: TaskSlateProps) {
  const { isMobile } = useDeviceLayout();
  const hasCards = sections.some((section) => section.tasks.length > 0);

  return (
    <div className={cn('rounded-xl border border-border bg-card p-3 md:p-4', className)}>
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">Possibilities</h3>
        <span className="text-[11px] text-muted-foreground">
          {hasCards ? (isMobile ? 'drag the handle onto the day above' : 'drag one onto a day above') : null}
        </span>
      </div>

      <SlateBody
        sections={sections}
        loading={loading}
        error={error}
        onDismissProposed={onDismissProposed}
        isMobile={isMobile}
        placeable
        paneClassName="max-h-72 overflow-hidden"
      />

      <ScheduleDragGhost />
    </div>
  );
}

function formatSlotHeading(slot: CalendarSlot): string {
  const day = slot.instant.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  return slot.allDay ? `${day} · All day` : `${day} · ${formatClock(slot.instant)}`;
}

interface TaskSlateDrawerProps extends Omit<TaskSlateProps, 'className'> {
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
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<EventDraft>(() => eventDraftAt(slot?.instant ?? new Date(), slot?.allDay));
  const [problem, setProblem] = useState<EventDraftProblem | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createEvent, { loading: creating }] = useMutation(CREATE_EVENT);

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
        className={cn('gap-0 p-0', isMobile ? 'max-h-[70vh] w-full sm:max-w-none' : 'w-[24rem] sm:max-w-md')}
      >
        <Sheet.Header className="gap-1 pb-1">
          <Sheet.Title className="text-sm">Add to calendar</Sheet.Title>
          <Sheet.Description className="text-[11px] tabular-nums">
            {slot ? formatSlotHeading(slot) : 'Pick an empty time'}
          </Sheet.Description>
        </Sheet.Header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <section aria-labelledby="slot-predictions-label" className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <h4
              id="slot-predictions-label"
              className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Predictions
            </h4>
            <p className={cn('mt-1 text-[13px] leading-snug', insight ? 'text-foreground' : 'text-muted-foreground')}>
              {insight ?? 'No predictions available'}
            </p>
          </section>

          {composing ? (
            <form onSubmit={handleSubmit} className="flex min-h-0 flex-col gap-4">
              <EventForm value={draft} onChange={setDraft} problem={problem} disabled={creating} />
              {submitError ? (
                <p role="alert" className="text-sm text-destructive">
                  {submitError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setComposing(false)} disabled={creating}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={creating}>
                  {creating ? 'Adding…' : 'Add'}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setComposing(true)}>
                New event
              </Button>

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
                  isMobile
                  placeable={false}
                  paneClassName="min-h-0"
                />
              </div>
            </>
          )}
        </div>
      </Sheet.Content>
    </Sheet>
  );
}
