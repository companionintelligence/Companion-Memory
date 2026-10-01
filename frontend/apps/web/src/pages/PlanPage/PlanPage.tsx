import { useState, type ReactNode } from 'react';

import { useMutation } from '@apollo/client';
import { EmptyState, LoadingPage, useDeviceLayout, usePageTitle } from '@ci/common';
import { AlertDialog, Button, cn, useToast } from '@ci/shadcn';
import { ListTodo } from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';
import { ErrorState } from '@/components/ErrorState';
import { resolveTimeZone } from '@/components/HorizonGrid/zonedClock';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';
import { useCurrentUser } from '@/hooks';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import { EditTaskModal, UPDATE_TASK, type EditableTask } from './EditTaskModal';
import { NewTaskForm } from './NewTaskForm';
import { describePendingChange } from './pendingRationale';
import { Task } from './Task';
import { TaskBoard } from './TaskBoard';
import { childrenOf, dueAtFromLocalDate, type SectionedTask } from './taskSections';
import { useDeleteTasks } from './useDeleteTasks';
import {
  ACCEPT_PROPOSED,
  DECLINE_PROPOSED,
  GET_TASKS,
  PLAN_TASK,
  SCHEDULE_TASK,
  SCHEDULE_TASK_AT,
  usePlanTasks,
} from './usePlanTasks';

const COMPLETE_TASK = gql(`
  mutation CompleteTask($id: ID!) {
    completeTask(id: $id) {
      id
      status
      completedAt
    }
  }
`);

const REOPEN_TASK = gql(`
  mutation ReopenTask($id: ID!) {
    reopenTask(id: $id) {
      id
      status
      completedAt
    }
  }
`);

const ACCEPT_PENDING = gql(`
  mutation AcceptTaskPendingChange($id: ID!) {
    acceptTaskPendingChange(id: $id) {
      success
      task {
        id
        status
        title
        notes
        parentId
      }
    }
  }
`);

const DECLINE_PENDING = gql(`
  mutation DeclineTaskPendingChange($id: ID!) {
    declineTaskPendingChange(id: $id) {
      success
    }
  }
`);

export function PlanPage() {
  usePageTitle('Plan - Companion Memory');
  const { isMobile } = useDeviceLayout();
  const { isFeatureEnabled } = useFeatures();
  const showEmptyState = isFeatureEnabled('planning.emptyState');
  const { toast } = useToast();
  const { user } = useCurrentUser();
  /**
   * A pending suggestion names its slot on the OWNER's clock — the zone the
   * backend placed it in (`ci.users.timezone`), the same one the Schedule grid
   * draws in. The browser zone is only the fallback. See `pendingRationale`.
   */
  const timeZone = resolveTimeZone(user?.timezone);
  const fmt = useDateTimeFormat();

  const { nodes, sections, pendingByTask, loading, error, refetch } = usePlanTasks();

  const [completeTask] = useMutation(COMPLETE_TASK);
  const [reopenTask] = useMutation(REOPEN_TASK);
  const [acceptProposed] = useMutation(ACCEPT_PROPOSED);
  const [declineProposed] = useMutation(DECLINE_PROPOSED);
  const [acceptPending] = useMutation(ACCEPT_PENDING);
  const [declinePending] = useMutation(DECLINE_PENDING);
  const [planTask] = useMutation(PLAN_TASK);
  const [scheduleTask] = useMutation(SCHEDULE_TASK);
  const [scheduleTaskAt] = useMutation(SCHEDULE_TASK_AT);
  const [updateTask] = useMutation(UPDATE_TASK);
  const [editingTask, setEditingTask] = useState<EditableTask | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [boardTab, setBoardTab] = useState<string | null>(null);
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const { deleteTasks, deleting } = useDeleteTasks();

  const handleToggle = (id: string, done: boolean) => {
    void (done ? completeTask({ variables: { id } }) : reopenTask({ variables: { id } }));
  };

  const handleDelete = (id: string) => {
    void deleteTasks([id]);
  };

  /**
   * The per-row trash control deliberately has no confirm — that click IS the
   * decision, and it removes exactly the one task under the cursor. Emptying a
   * whole selection is a different blast radius: nothing here names what is
   * about to go, and there is no undo behind it, so this one path asks first.
   * A failure still toasts rather than holding the dialog open, so the
   * confirmation closes either way and the selection survives for a retry.
   */
  const handleBulkDelete = () => {
    void deleteTasks(selectedIds).then((ok) => {
      setConfirmingBulkDelete(false);

      if (ok) {
        setSelectedIds([]);
      }
    });
  };

  const handleEdit = (task: EditableTask) => {
    setEditingTask(task);
  };

  const handleLongPressSelect = (id: string) => {
    setSelectedIds((current) => (current.includes(id) ? current : [...current, id]));
  };

  const handleSelectToggle = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const refresh = () => {
    void refetch();
  };

  /**
   * ═══ THE PAYLOAD USED TO BE DISCARDED HERE ═══
   *
   * `scheduleTask` can legitimately return `success: false` with a `status` of
   * `no_gap` (the 7-day flex window is fully booked within working hours) or
   * `skipped` (the task is done/archived/skipped, or lost a race) — neither is
   * a thrown error, so `.then(refresh)` alone re-renders the identical board
   * and says nothing. The button read as dead on a full week, which is
   * silently the MOST likely week to hit it on.
   */
  const scheduleStatusMessage: Record<string, string> = {
    no_gap:
      'No free slot in your working hours over the next week — try a specific day, or shorten the estimate.',
    skipped: 'That task can no longer be scheduled — it may already be done or removed.',
    already_placed: 'That task already has a block on your calendar — move it from the calendar.',
  };

  /**
   * `already_placed` used to be silent, alongside `placed`. It is not a
   * success: the gap solver never ran and nothing moved. Every path that can
   * legitimately reach it now names a destination (see `handleReschedule`), so
   * the only ways left are a stale board — the card says unplaced, the server
   * disagrees — and a lost race, and both of those are exactly what the user
   * needs told rather than shown as a button that does nothing.
   */
  const reportScheduleOutcome = (status: string | null | undefined) => {
    if (!status || status === 'placed') {
      return;
    }

    toast.error(scheduleStatusMessage[status] ?? 'Could not schedule that task. Try again shortly.');
  };

  /**
   * ═══ A THROWN MUTATION USED TO SAY NOTHING AT ALL ═══
   *
   * None of these paths had a `.catch`, so a network or GraphQL failure aborted
   * the async block: no toast, no refetch, and the card simply snapped back to
   * where it was. `handlePlan` below already carried the fix; its siblings did
   * not. Refreshing in `finally` also puts the board back in step with the
   * server after a partial sequence (an `updateTask` that landed, a
   * `scheduleTask` that did not).
   */
  const handleSchedule = (id: string) => {
    void (async () => {
      try {
        const result = await scheduleTask({ variables: { id } });

        reportScheduleOutcome(result.data?.scheduleTask.status);
      } catch {
        toast.error('Could not schedule that task. Try again shortly.');
      } finally {
        refresh();
      }
    })();
  };

  /**
   * ═══ RESCHEDULING A PLACED TASK USED TO MOVE ONLY THE DUE DATE ═══
   *
   * Reschedule is the recovery affordance for overdue work, and overdue work
   * very often already HAS a planned block — Task renders the picker for any
   * overdue task, placed or not. `SCHEDULE_TASK`'s date-only path cannot move
   * one: `PlannedBlockService.place` finds the existing block and returns
   * `already_placed` before the gap solver runs. So the `updateTask` above
   * landed, the block stayed on the day that has already passed, the card
   * stayed in Overdue, and `already_placed` was silent — the user moved their
   * due date by pressing a button that told them it had done nothing.
   *
   * `SCHEDULE_TASK_AT` is the mutation that MOVES a block: `scheduleTaskAt`
   * reschedules the existing event (preserving its duration) instead of
   * refusing. The instant it is given is the same local noon the new due date
   * is set to, because a day picker names a day and there is no time of day to
   * honour — the block's own start is not on the board to reuse. An unplaced
   * task still goes through the gap solver, which is the better answer when
   * there is nothing to move and working hours are the only constraint.
   *
   * `scheduledFor` is written alongside `dueAt` on that path and only on that
   * path: `CalendarEventService.reschedule` moves the event and nothing
   * updates the task, so without it `sectionFor` — which takes the EARLIEST of
   * dueAt and scheduledFor — would keep the card in Overdue on the strength of
   * the stale date. The gap-solver path needs no such help; `placeAt` sets
   * `scheduledFor` from where it actually placed the block.
   */
  const handleReschedule = (id: string, date: string) => {
    const placed = nodes.find((task) => task.id === id)?.placedOnCalendar === true;
    const dueAt = dueAtFromLocalDate(date);

    void (async () => {
      try {
        await updateTask({
          variables: {
            input: placed ? { id, dueAt, scheduledFor: date } : { id, dueAt },
          },
        });

        const result = placed
          ? await scheduleTaskAt({ variables: { id, startTime: dueAt } })
          : await scheduleTask({ variables: { id, date } });

        reportScheduleOutcome(result.data?.scheduleTask.status);
      } catch {
        toast.error('Could not move that task. Try again shortly.');
      } finally {
        refresh();
      }
    })();
  };

  const showUnscheduled = () => {
    setBoardTab('unscheduled');
  };

  const handlePlan = (id: string) => {
    void (async () => {
      try {
        await planTask({
          variables: { id },
          refetchQueries: [{ query: GET_TASKS, variables: { first: 200 } }],
          awaitRefetchQueries: true,
        });
      } catch {
        toast.error('Could not move that task to Unscheduled. Try again.');
      } finally {
        showUnscheduled();
      }
    })();
  };

  const handleAcceptAndSchedule = (id: string) => {
    void (async () => {
      try {
        await acceptProposed({ variables: { id } });

        const result = await scheduleTask({ variables: { id } });

        reportScheduleOutcome(result.data?.scheduleTask.status);
      } catch {
        toast.error('Could not schedule that task. Try again shortly.');
      } finally {
        refresh();
      }
    })();
  };

  const renderTree = (task: SectionedTask, depth: number): ReactNode => {
    const pending = pendingByTask.get(task.id);
    const kids = childrenOf(nodes as unknown as SectionedTask[], task.id);

    return (
      <Task
        key={task.id}
        task={task as never}
        depth={depth}
        onToggle={handleToggle}
        onDelete={handleDelete}
        onEdit={handleEdit}
        selecting={selectedIds.length > 0}
        selected={selectedIds.includes(task.id)}
        onSelectToggle={handleSelectToggle}
        onLongPressSelect={handleLongPressSelect}
        onAcceptProposed={handlePlan}
        onDeclineProposed={(id) => {
          void (async () => {
            try {
              // Only a `schedule` change is orphaned by this Dismiss. Task
              // renders the proposed row INSTEAD of the pending-schedule row,
              // so declining the proposal alone left that change open on the
              // server with no UI left that could ever answer it. Every other
              // kind still gets its own Confirm/Dismiss row alongside the
              // proposed row, so the user is answering it themselves —
              // declining it from here would silently answer for them.
              if (pending?.kind === 'schedule') {
                await declinePending({ variables: { id: pending.id } });
              }

              await declineProposed({ variables: { id } });
            } catch {
              toast.error('Could not dismiss that task. Try again shortly.');
            } finally {
              refresh();
            }
          })();
        }}
        onAcceptAndSchedule={handleAcceptAndSchedule}
        onSchedule={handleSchedule}
        onReschedule={handleReschedule}
        pendingChangeId={pending?.id}
        pendingRationale={pending ? describePendingChange(pending, timeZone, fmt) : null}
        pendingKind={pending?.kind}
        onAcceptPending={(changeId) => void acceptPending({ variables: { id: changeId } }).then(refresh)}
        onDeclinePending={(changeId) => void declinePending({ variables: { id: changeId } }).then(refresh)}
        onPlanPending={(taskId) => handlePlan(taskId)}
        onDismissPendingTask={(taskId, changeId) => {
          void (async () => {
            try {
              // Only ever reached from the pending-schedule row, which a
              // proposed card never renders — Task prefers the proposed
              // actions when both apply. The `status === 'proposed'` branch
              // that used to sit here was dead; the proposed card's own
              // Dismiss handles that case.
              await declinePending({ variables: { id: changeId } });
              await updateTask({ variables: { input: { id: taskId, status: 'archived' } } });
            } catch {
              toast.error('Could not dismiss that suggestion. Try again shortly.');
            } finally {
              refresh();
            }
          })();
        }}
      >
        {kids.map((child) => renderTree(child, depth + 1))}
      </Task>
    );
  };

  let content: ReactNode;

  // `cache-and-network` re-reports loading on every revisit, so only show the
  // spinner when there is genuinely nothing to render yet.
  if (loading && nodes.length === 0) {
    content = <LoadingPage />;
  } else if (error && nodes.length === 0) {
    // A failed query used to fall through to the branch below and render
    // NOTHING — the flag-gated empty state is off by default, so `content` was
    // set to null and the page was the add-task form over blank space. A person
    // with forty tasks was shown the same screen as a person with none, with no
    // spinner, no message and no retry, and the reasonable conclusion is that
    // their plan was wiped. `usePlanTasks` has always returned this flag;
    // nothing read it. `TaskSlate`, fed by the same hook, gets it right.
    content = (
      <ErrorState
        title="Could not load your plan"
        description="Your tasks are still here — this device could not reach them just now."
        onRetry={() => void refetch()}
      />
    );
  } else if (nodes.length === 0) {
    // The board renders even with nothing in it. `withAllColumns` exists
    // precisely to keep the four columns present when their buckets are empty,
    // and it was never reached on this path: a first-time user saw an add-task
    // box over blank space, with no hint that Proposed / Unscheduled /
    // Scheduled / Done exist or that the system will propose things into them.
    // The columns ARE the explanation of what this page does.
    content = (
      <>
        <TaskBoard
          sections={[]}
          renderTask={(task) => renderTree(task, 0)}
          tab={boardTab}
          onTabChange={setBoardTab}
        />
        {showEmptyState ? (
          <EmptyState
            icon={<ListTodo size={48} />}
            message={<div>Nothing planned yet. Add your first task above.</div>}
          />
        ) : null}
      </>
    );
  } else {
    content = (
      <TaskBoard
        sections={sections}
        renderTask={(task) => renderTree(task, 0)}
        tab={boardTab}
        onTabChange={setBoardTab}
      />
    );
  }

  return (
    <>
      <PageContent>
        <div className={cn('flex h-full min-h-0 w-full flex-col', isMobile ? 'gap-2' : 'gap-6')}>
          <div className="mx-auto w-full max-w-3xl shrink-0">
            <NewTaskForm onCreated={() => void refetch()} />
          </div>

          {selectedIds.length > 0 ? (
            <div
              className="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
              data-testid="plan-selection-bar"
            >
              <span className="text-sm font-medium">{selectedIds.length} selected</span>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setSelectedIds([])}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmingBulkDelete(true)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ) : null}

          {/* `relative` scopes the loading and empty states, both of which
              position themselves `absolute inset-0`. Without a positioned
              parent here they fill the whole column and sit on top of the form,
              swallowing clicks on Add. `min-h-0` lets the board fill leftover
              height so each column scrolls instead of the whole page. */}
          <div className="relative flex min-h-0 flex-1 flex-col">{content}</div>
        </div>
      </PageContent>

      {editingTask && (
        <EditTaskModal task={editingTask} onClose={() => setEditingTask(null)} onSaved={refresh} />
      )}

      <AlertDialog
        open={confirmingBulkDelete && selectedIds.length > 0}
        onOpenChange={(open) => !open && setConfirmingBulkDelete(false)}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {selectedIds.length === 1 ? 'Delete this task?' : `Delete ${selectedIds.length} tasks?`}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {selectedIds.length === 1
                ? 'This task will be permanently deleted from your plan. This cannot be undone.'
                : `These ${selectedIds.length} tasks will be permanently deleted from your plan. This cannot be undone.`}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={deleting}>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              // The confirm has to carry its own destructive styling:
              // AlertDialog.Action renders the DEFAULT button variant, unlike
              // the `variant="destructive"` Button the Dialog-based delete
              // modals use.
              className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60"
              disabled={deleting}
              onClick={(e) => {
                // Radix auto-closes on Action click; keep it open so the
                // in-flight state stays visible until the deletes finish.
                e.preventDefault();
                handleBulkDelete();
              }}
            >
              {deleting
                ? 'Deleting…'
                : selectedIds.length === 1
                  ? 'Delete task'
                  : `Delete ${selectedIds.length} tasks`}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
}
