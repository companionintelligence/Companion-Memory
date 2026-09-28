import { useEffect, useRef, useState } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Button, Checkbox, IconButton, cn } from '@ci/shadcn';
import { CalendarRange, ChevronDown, Pencil, Trash } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';
import { namedChatContext } from '@/lib/agentChat';

import { isOverdue, localDateOf } from './taskSections';
import { WhenSelector } from './WhenSelector';

export type EditableTaskFields = {
  id: string;
  title: string;
  description?: string | null;
  dueAt?: string | null;
  estimatedMinutes?: number | null;
};

interface Props {
  task: FragmentType<typeof TaskRowFragment>;
  depth?: number;
  onToggle: (id: string, done: boolean) => void;
  onDelete: (id: string) => void;
  onEdit?: (task: EditableTaskFields) => void;
  onAcceptProposed?: (id: string) => void;
  onDeclineProposed?: (id: string) => void;
  onAcceptAndSchedule?: (id: string) => void;
  onSchedule?: (id: string) => void;
  /** Move an overdue task onto a user-local `YYYY-MM-DD`. */
  onReschedule?: (id: string, date: string) => void;
  pendingChangeId?: string | null;
  pendingRationale?: string | null;
  pendingKind?: string | null;
  onAcceptPending?: (changeId: string) => void;
  onDeclinePending?: (changeId: string) => void;
  /** Keep the task, drop the calendar suggestion, and file it as Unscheduled. */
  onPlanPending?: (taskId: string, changeId: string) => void;
  /** Archive the task and drop its pending change — same as Dismiss on a proposal. */
  onDismissPendingTask?: (taskId: string, changeId: string) => void;
  /** Long-press multi-select on a phone. */
  selecting?: boolean;
  selected?: boolean;
  onSelectToggle?: (id: string) => void;
  onLongPressSelect?: (id: string) => void;
  children?: React.ReactNode;
}

export const TaskRowFragment = gql(`
  fragment TaskRowFragment on TaskType {
    id
    title
    description
    status
    priority
    parentId
    dueAt
    scheduledFor
    placedOnCalendar
    deferUntil
    estimatedMinutes
    completedAt
  }
`);

const PRIORITY_LABELS: Record<number, string> = {
  0: 'Critical',
  1: 'High',
  2: 'Elevated',
  4: 'Low',
  5: 'Lowest',
};

/**
 * ═══ PLAN / SCHEDULE / DISMISS USED TO OVERLAP ═══
 *
 * The decision row was a `grid-cols-3` of `min-w-0` buttons. A Button is
 * `whitespace-nowrap`, so a column narrower than its label did not shrink the
 * label — it spilled out of the button into the next one, and a narrow Proposed
 * card read "ScheduleDismiss".
 *
 * Now each button starts from nothing and grows equally (`flex-1`, i.e. a zero
 * basis), so the three are the same width whenever they fit on one line — the
 * phone look this row was built for — but never narrower than their own label
 * (`min-w-fit`), and the row wraps instead of overlapping when they do not.
 */
const DECISION_ROW = 'flex w-full flex-wrap gap-2';
const DECISION_BUTTON = 'min-w-fit flex-1 px-2';

/** Hold this long before a phone card becomes a selection, so a flick still scrolls. */
export const SELECT_HOLD_MS = 450;
const SELECT_CANCEL_PX = 12;

type Gesture = {
  pointerId: number;
  timer: number;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
};

/** Drop a hold in progress: its timer and its three window listeners. */
function endGesture(gesture: React.MutableRefObject<Gesture | null>) {
  const current = gesture.current;

  if (!current) {
    return;
  }

  gesture.current = null;
  window.clearTimeout(current.timer);
  window.removeEventListener('pointermove', current.onMove);
  window.removeEventListener('pointerup', current.onUp);
  window.removeEventListener('pointercancel', current.onUp);
}

/** `2026-01-15T17:00:00Z` -> `Jan 15`, in the viewer's own zone. */
function formatDue(dueAt: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(dueAt));
}

export function Task({
  task: taskMasked,
  depth = 0,
  onToggle,
  onDelete,
  onEdit,
  onAcceptProposed,
  onDeclineProposed,
  onAcceptAndSchedule,
  onSchedule,
  onReschedule,
  pendingChangeId,
  pendingRationale,
  pendingKind,
  onAcceptPending,
  onDeclinePending,
  onPlanPending,
  onDismissPendingTask,
  selecting = false,
  selected = false,
  onSelectToggle,
  onLongPressSelect,
  children,
}: Props) {
  const { t } = useTranslation();
  const { isMobile } = useDeviceLayout();
  const task = useFragment(TaskRowFragment, taskMasked);
  const done = task.status === 'done';
  const proposed = task.status === 'proposed';
  // Handed to an agent harness. Scheduling a block for work the user is not
  // doing themselves would put a lie on their calendar.
  const delegated = task.status === 'delegated';
  const overdue = isOverdue(task, localDateOf(new Date()));
  const [pickingWhen, setPickingWhen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const suppressTap = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const priorityLabel = PRIORITY_LABELS[task.priority];
  const phone = isMobile === true;
  const canSelect = phone && Boolean(onLongPressSelect || onSelectToggle);
  // Accepting a pending `schedule` and scheduling outright are the same
  // one-word action, so never offer Schedule twice on one card.
  const pendingSchedule =
    Boolean(pendingChangeId && onAcceptPending && onDeclinePending) && pendingKind === 'schedule';

  const editPayload: EditableTaskFields = {
    id: task.id,
    title: task.title,
    description: task.description,
    dueAt: task.dueAt as string | null,
    estimatedMinutes: task.estimatedMinutes,
  };
  const chatContext = namedChatContext({
    title: task.title,
    body: task.description,
    sourceKind: 'Task',
    sourceId: task.id,
  });

  const activateBody = () => {
    if (suppressTap.current) {
      suppressTap.current = false;

      return;
    }

    if (selecting && onSelectToggle) {
      onSelectToggle(task.id);

      return;
    }

    onEdit?.(editPayload);
  };

  /**
   * ═══ THE HOLD USED TO OUTLIVE THE CARD ═══
   *
   * Radix Tabs unmounts the inactive panel, so a hold begun just before a tab
   * switch fired against a card the user could no longer see and popped the
   * selection bar over a different column. Nothing cleared the timer or the
   * window listeners on unmount.
   */
  useEffect(() => () => endGesture(gesture), []);

  const onSelectPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!canSelect || selecting) {
      return;
    }

    // Every pointer type may hold, mouse included: the phone card layout is
    // also what an iPad with a trackpad and any narrowed desktop window get,
    // and selection is the only route to bulk delete. The hold duration and
    // the move threshold are what separate a deliberate hold from a click.
    if (event.button !== 0) {
      return;
    }

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const timer = window.setTimeout(() => {
      const current = gesture.current;

      if (!current || current.pointerId !== pointerId) {
        return;
      }

      endGesture(gesture);
      suppressTap.current = true;
      onLongPressSelect?.(task.id);
    }, SELECT_HOLD_MS);

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > SELECT_CANCEL_PX) {
        endGesture(gesture);
      }
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) {
        endGesture(gesture);
      }
    };

    gesture.current = { pointerId, timer, onMove, onUp };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const stop = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  // Chat / Edit / Delete. On a phone they used to sit in the title row (or a
  // kebab that still occupied that corner), so a narrow card spent its width
  // on chrome the title needed. They live on their own layer, next to
  // Schedule when it fits and above it when the row wraps.
  const overflowActions = !selecting ? (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="task-overflow-actions">
      <ChatWithAgentMenu context={chatContext} />
      {onEdit ? (
        <IconButton
          onClick={(event) => {
            stop(event);
            onEdit(editPayload);
          }}
          variant="ghost"
          label={t('PLAN_TASK_EDIT', { title: task.title })}
        >
          <Pencil className="h-4 w-4" />
        </IconButton>
      ) : null}
      <IconButton
        onClick={(event) => {
          stop(event);
          onDelete(task.id);
        }}
        variant="ghost"
        label={t('PLAN_TASK_DELETE', { title: task.title })}
      >
        <Trash className="h-4 w-4" />
      </IconButton>
    </div>
  ) : null;

  const showStandaloneSchedule =
    !proposed &&
    !done &&
    !delegated &&
    !overdue &&
    !task.placedOnCalendar &&
    !pendingSchedule &&
    Boolean(onSchedule);

  const showReschedule = !proposed && !done && overdue && Boolean(onReschedule);

  const showConfirmDismiss = Boolean(
    pendingChangeId && !pendingSchedule && onAcceptPending && onDeclinePending,
  );

  const scheduleButton = showStandaloneSchedule ? (
    <Button
      type="button"
      size="sm"
      onClick={(event) => {
        stop(event);
        onSchedule?.(task.id);
      }}
    >
      <CalendarRange className="h-4 w-4" />
      Schedule
    </Button>
  ) : null;

  const rescheduleButton =
    showReschedule && !pickingWhen ? (
      <Button
        type="button"
        size="sm"
        onClick={(event) => {
          stop(event);
          setPickingWhen(true);
        }}
        aria-label={`Reschedule ${task.title}`}
      >
        <CalendarRange className="h-4 w-4" />
        Reschedule
      </Button>
    ) : null;

  const confirmDismiss = showConfirmDismiss ? (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        variant="default"
        onClick={(event) => {
          stop(event);
          onAcceptPending?.(pendingChangeId!);
        }}
      >
        Confirm
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={(event) => {
          stop(event);
          onDeclinePending?.(pendingChangeId!);
        }}
      >
        Dismiss
      </Button>
    </div>
  ) : null;

  const whenPicker =
    showReschedule && pickingWhen ? (
      <WhenSelector
        onPick={(date) => {
          setPickingWhen(false);
          onReschedule?.(task.id, date);
        }}
        onCancel={() => setPickingWhen(false)}
      />
    ) : null;

  return (
    <li
      className={cn(
        // `@container/task` lets the desktop card lay itself out by ITS OWN
        // width — see `task-head` below. `min-w-0` stops a long unbreakable
        // run inside it from widening the column it sits in.
        '@container/task flex min-w-0 flex-col rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md',
        phone ? 'gap-1.5 p-2' : 'gap-2 p-3',
        selected ? 'border-primary ring-2 ring-primary/40' : 'border-border',
      )}
      style={{
        // A phone indents less per level: 1.25rem a level leaves a grandchild
        // card too narrow for its own action row.
        marginLeft: depth > 0 ? `${depth * (phone ? 0.75 : 1.25)}rem` : undefined,
      }}
      aria-selected={selecting ? selected : undefined}
      data-testid="plan-task"
    >
      {/*
        ═══ THE DESKTOP CARD USED TO SIZE ITSELF BY THE WINDOW ═══

        Chat / Edit / Delete sat on the title row whenever the viewport was
        desktop-wide, which says nothing about the CARD: the board splits that
        width four ways, and at a ~1024px window a card had ~150-180px inside
        its padding. The checkbox and the three 36px icon buttons took ~150 of
        it, and the title and rationale — `min-w-0 flex-1`, as they should be —
        were squeezed to a character or two per line.

        The row now wraps on the card's own width. Below 22rem of card the lead
        (checkbox + text) takes a whole line and the icons drop to the next one,
        beside Schedule when it fits — the same arrangement the phone action
        layer uses. From 22rem the lead shares its line with the icons again,
        which still leaves the title ~12rem, and the buttons move under the text.

        A phone card has ~360px to spend: the tighter gap buys the action row
        the width it needs to stay on one line.
      */}
      <div
        className={cn('flex items-start', phone ? 'gap-2' : 'flex-wrap gap-x-3 gap-y-2')}
        data-testid="task-head"
      >
        <div
          className={cn(
            'flex min-w-0 items-start',
            phone ? 'flex-1 gap-2' : 'basis-full gap-3 @[22rem]/task:grow @[22rem]/task:basis-0',
          )}
          data-testid="task-lead"
        >
          {!selecting && !proposed ? (
            <Checkbox
              // The box stays 16px; the transparent ::before makes it a tap
              // target. Completing a task is the primary action on every card,
              // and a near-miss used to land on the card padding or the title
              // button — which opens the edit modal instead.
              //
              // The reach to the RIGHT is capped at 0.5rem because that is the
              // phone row's whole `gap-2`: a uniform `-inset-2.5` reached 10px
              // and so painted 2px over the title button's left edge — and the
              // checkbox is positioned while the title was not, so those pixels
              // completed the task instead of opening edit. Up, down and left is
              // card padding, which nothing else is competing for.
              className="relative mt-1 before:absolute before:-inset-y-2.5 before:-left-2.5 before:-right-2"
              checked={done}
              onCheckedChange={(checked) => onToggle(task.id, checked === true)}
              aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
            />
          ) : (
            <span
              className={cn(
                'mt-1 inline-flex h-4 w-4 shrink-0 rounded-sm border',
                selecting && selected
                  ? 'border-primary bg-primary'
                  : 'border-dashed border-muted-foreground/50',
              )}
              aria-hidden
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-start gap-1">
              {phone ? (
                <button
                  type="button"
                  className={cn(
                    // `relative` is not layout: it is what makes the title win
                    // its own pixels. The checkbox beside it is positioned and
                    // grows a ::before tap target, and an unpositioned title
                    // paints beneath any of it that reaches over.
                    'relative min-w-0 flex-1 break-words text-left font-medium line-clamp-5',
                    done ? 'text-muted-foreground line-through' : '',
                  )}
                  onClick={activateBody}
                  onPointerDown={onSelectPointerDown}
                >
                  {task.title}
                </button>
              ) : (
                <span
                  className={`min-w-0 flex-1 break-words line-clamp-5 font-medium ${done ? 'text-muted-foreground line-through' : ''}`}
                >
                  {task.title}
                </span>
              )}

              {/* Full icon-button size, not the 32px this used to be overridden
                  to: on a phone the chevron is the ONLY way to read a
                  description, and it sits against a much larger title button
                  that opens the edit modal on a mis-tap. */}
              {phone && task.description ? (
                <IconButton
                  type="button"
                  variant="ghost"
                  className="shrink-0"
                  label={
                    descOpen ? `Hide description for ${task.title}` : `Show description for ${task.title}`
                  }
                  onClick={(event) => {
                    stop(event);
                    setDescOpen((open) => !open);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <ChevronDown className={cn('h-4 w-4 transition-transform', descOpen && 'rotate-180')} />
                </IconButton>
              ) : null}
            </div>

            {task.description && (!phone || descOpen) ? (
              <span
                className={cn(
                  'break-words text-sm text-muted-foreground',
                  phone ? 'whitespace-pre-wrap' : 'line-clamp-2',
                )}
              >
                {task.description}
              </span>
            ) : null}

            {/* `break-words`: rationales are machine-written and used to carry a
                raw ISO timestamp — one unbreakable run wider than a narrow card. */}
            {pendingRationale ? (
              <span
                className="break-words text-sm text-amber-700 dark:text-amber-300"
                data-testid="task-rationale"
              >
                {pendingRationale}
              </span>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {proposed ? <span>Proposed</span> : null}
              {/* Without this the card is indistinguishable from an open task
                  that has simply lost its Schedule button. */}
              {delegated ? <span>Delegated</span> : null}
              {task.dueAt ? <span>Due {formatDue(task.dueAt as string)}</span> : null}
              {task.scheduledFor ? (
                <span>
                  {task.placedOnCalendar ? `Planned ${task.scheduledFor}` : `Suggested ${task.scheduledFor}`}
                </span>
              ) : null}
              {task.estimatedMinutes ? <span>{task.estimatedMinutes} min</span> : null}
              {priorityLabel ? <span>{priorityLabel}</span> : null}
            </div>
          </div>
        </div>

        {!phone ? overflowActions : null}

        {!phone && (rescheduleButton || scheduleButton || confirmDismiss) ? (
          <div
            className="flex min-w-0 flex-wrap items-center gap-2 @[22rem]/task:basis-full @[22rem]/task:pl-7"
            data-testid="task-buttons"
          >
            {rescheduleButton}
            {scheduleButton}
            {confirmDismiss}
          </div>
        ) : null}

        {!phone && whenPicker ? (
          <div className="min-w-0 basis-full @[22rem]/task:pl-7">{whenPicker}</div>
        ) : null}
      </div>

      {phone && !selecting ? (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="task-action-layer">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {overflowActions}
            {rescheduleButton}
            {scheduleButton}
            {confirmDismiss}
          </div>
          {whenPicker}
        </div>
      ) : null}

      {proposed && onAcceptProposed && onDeclineProposed ? (
        <div className={DECISION_ROW} data-testid="proposed-actions">
          <Button
            type="button"
            size="sm"
            variant="default"
            className={DECISION_BUTTON}
            onClick={(event) => {
              stop(event);
              onAcceptProposed(task.id);
            }}
          >
            Plan
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={DECISION_BUTTON}
            disabled={!onAcceptAndSchedule}
            onClick={(event) => {
              stop(event);
              onAcceptAndSchedule?.(task.id);
            }}
          >
            Schedule
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={DECISION_BUTTON}
            onClick={(event) => {
              stop(event);
              onDeclineProposed(task.id);
            }}
          >
            Dismiss
          </Button>
        </div>
      ) : pendingSchedule && pendingChangeId && onAcceptPending && onDeclinePending ? (
        <div className={DECISION_ROW} data-testid="pending-schedule-actions">
          <Button
            type="button"
            size="sm"
            variant="default"
            className={DECISION_BUTTON}
            onClick={(event) => {
              stop(event);
              if (onPlanPending) {
                onPlanPending(task.id, pendingChangeId);
              } else {
                onDeclinePending(pendingChangeId);
              }
            }}
          >
            Plan
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={DECISION_BUTTON}
            onClick={(event) => {
              stop(event);
              onAcceptPending(pendingChangeId);
            }}
          >
            Schedule
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={DECISION_BUTTON}
            onClick={(event) => {
              stop(event);
              if (onDismissPendingTask) {
                onDismissPendingTask(task.id, pendingChangeId);
              } else {
                onDeclinePending(pendingChangeId);
              }
            }}
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      {children ? <ul className="flex flex-col gap-2">{children}</ul> : null}
    </li>
  );
}
