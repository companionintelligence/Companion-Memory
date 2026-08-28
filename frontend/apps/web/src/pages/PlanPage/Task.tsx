import { useRef, useState } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Button, Checkbox, DropdownMenu, IconButton, cn } from '@ci/shadcn';
import { CalendarRange, ChevronDown, MoreHorizontal, Pencil, Trash } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';

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

/** Hold this long before a phone card becomes a selection, so a flick still scrolls. */
export const SELECT_HOLD_MS = 450;
const SELECT_CANCEL_PX = 12;

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
  const overdue = isOverdue(task, localDateOf(new Date()));
  const [pickingWhen, setPickingWhen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const suppressTap = useRef(false);
  const gesture = useRef<{ pointerId: number; startX: number; startY: number; timer: number } | null>(
    null,
  );
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

  const onSelectPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!canSelect || selecting) {
      return;
    }

    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
      return;
    }

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

      suppressTap.current = true;
      gesture.current = null;
      onLongPressSelect?.(task.id);
    }, SELECT_HOLD_MS);

    gesture.current = { pointerId, startX, startY, timer };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const current = gesture.current;

      if (!current) {
        return;
      }

      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > SELECT_CANCEL_PX) {
        window.clearTimeout(current.timer);
        gesture.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      }
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) {
        return;
      }

      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);

      const current = gesture.current;
      gesture.current = null;

      if (current) {
        window.clearTimeout(current.timer);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const stop = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <li
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition-shadow hover:shadow-md',
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
      {/* A phone card has ~360px to spend: the tighter gap buys the action row
          the width it needs to stay on one line. */}
      <div className={cn('flex items-start', phone ? 'gap-2' : 'gap-3')}>
        {!selecting && !proposed ? (
          <Checkbox
            className="mt-1"
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
                  'min-w-0 flex-1 break-words text-left font-medium',
                  done ? 'text-muted-foreground line-through' : '',
                )}
                onClick={activateBody}
                onPointerDown={onSelectPointerDown}
              >
                {task.title}
              </button>
            ) : (
              <span className={`min-w-0 flex-1 truncate font-medium ${done ? 'text-muted-foreground line-through' : ''}`}>
                {task.title}
              </span>
            )}

            {phone && task.description ? (
              <IconButton
                type="button"
                variant="ghost"
                className="mt-0.5 h-8 w-8 shrink-0"
                label={descOpen ? `Hide description for ${task.title}` : `Show description for ${task.title}`}
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
            <span className={cn('text-sm text-muted-foreground', phone ? 'whitespace-pre-wrap' : 'line-clamp-2')}>
              {task.description}
            </span>
          ) : null}

          {pendingRationale ? (
            <span className="text-sm text-amber-700 dark:text-amber-300">{pendingRationale}</span>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {proposed ? <span>Proposed</span> : null}
            {task.dueAt ? <span>Due {formatDue(task.dueAt as string)}</span> : null}
            {task.scheduledFor ? <span>Planned {task.scheduledFor}</span> : null}
            {task.estimatedMinutes ? <span>{task.estimatedMinutes} min</span> : null}
            {priorityLabel ? <span>{priorityLabel}</span> : null}
          </div>

          {proposed && onAcceptProposed && onDeclineProposed ? (
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="default"
                onClick={(event) => {
                  stop(event);
                  onAcceptProposed(task.id);
                }}
              >
                Plan
              </Button>
              {onAcceptAndSchedule ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={(event) => {
                    stop(event);
                    onAcceptAndSchedule(task.id);
                  }}
                >
                  Schedule
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={(event) => {
                  stop(event);
                  onDeclineProposed(task.id);
                }}
              >
                Dismiss
              </Button>
            </div>
          ) : null}

          {!proposed && !done && overdue && onReschedule ? (
            pickingWhen ? (
              <WhenSelector
                onPick={(date) => {
                  setPickingWhen(false);
                  onReschedule(task.id, date);
                }}
                onCancel={() => setPickingWhen(false)}
              />
            ) : (
              <div className="mt-1 flex flex-wrap gap-2">
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
              </div>
            )
          ) : null}

          {!proposed && !done && !overdue && !task.scheduledFor && !pendingSchedule && onSchedule ? (
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={(event) => {
                  stop(event);
                  onSchedule(task.id);
                }}
              >
                <CalendarRange className="h-4 w-4" />
                Schedule
              </Button>
            </div>
          ) : null}

          {pendingChangeId && onAcceptPending && onDeclinePending ? (
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="default"
                onClick={(event) => {
                  stop(event);
                  onAcceptPending(pendingChangeId);
                }}
              >
                {pendingKind === 'schedule' ? 'Schedule' : 'Confirm'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={(event) => {
                  stop(event);
                  onDeclinePending(pendingChangeId);
                }}
              >
                Ignore
              </Button>
            </div>
          ) : null}
        </div>

        {phone && !selecting ? (
          <DropdownMenu modal={false}>
            <DropdownMenu.Trigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label={t('PLAN_TASK_MORE', { title: task.title })}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              {onEdit ? (
                <DropdownMenu.Item
                  onSelect={() => {
                    onEdit(editPayload);
                  }}
                >
                  Edit
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Item variant="destructive" onSelect={() => onDelete(task.id)}>
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        ) : null}

        {!phone ? (
          <div className="flex shrink-0 items-center gap-0.5">
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
        ) : null}
      </div>

      {children ? <ul className="flex flex-col gap-2">{children}</ul> : null}
    </li>
  );
}
