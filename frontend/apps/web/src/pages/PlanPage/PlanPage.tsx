import { useState, type ReactNode } from 'react';

import { useMutation } from '@apollo/client';
import { EmptyState, LoadingPage, usePageTitle } from '@ci/common';
import { Button, useToast } from '@ci/shadcn';
import { ListTodo } from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';
import { ErrorState } from '@/components/ErrorState';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

import { DeleteTaskModal } from './DeleteTaskModal';
import { EditTaskModal, UPDATE_TASK, type EditableTask } from './EditTaskModal';
import { NewTaskForm } from './NewTaskForm';
import { Task } from './Task';
import { TaskBoard } from './TaskBoard';
import { childrenOf, dueAtFromLocalDate, type SectionedTask } from './taskSections';
import { ACCEPT_PROPOSED, DECLINE_PROPOSED, SCHEDULE_TASK, usePlanTasks } from './usePlanTasks';

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
  usePageTitle('Plan - Companion Intelligence');
  const { isFeatureEnabled } = useFeatures();
  const showEmptyState = isFeatureEnabled('planning.emptyState');
  const { toast } = useToast();

  const { nodes, sections, pendingByTask, loading, error, refetch } = usePlanTasks();

  const [completeTask] = useMutation(COMPLETE_TASK);
  const [reopenTask] = useMutation(REOPEN_TASK);
  const [acceptProposed] = useMutation(ACCEPT_PROPOSED);
  const [declineProposed] = useMutation(DECLINE_PROPOSED);
  const [acceptPending] = useMutation(ACCEPT_PENDING);
  const [declinePending] = useMutation(DECLINE_PENDING);
  const [scheduleTask] = useMutation(SCHEDULE_TASK);
  const [updateTask] = useMutation(UPDATE_TASK);
  const [focusedTasks, setFocusedTasks] = useState<string[] | null>(null);
  const [editingTask, setEditingTask] = useState<EditableTask | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const handleToggle = (id: string, done: boolean) => {
    void (done ? completeTask({ variables: { id } }) : reopenTask({ variables: { id } }));
  };

  const handleDelete = (id: string) => {
    setFocusedTasks([id]);
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
  };

  const reportScheduleOutcome = (status: string | null | undefined) => {
    if (!status || status === 'placed' || status === 'already_placed') {
      return;
    }

    toast.error(scheduleStatusMessage[status] ?? 'Could not schedule that task. Try again shortly.');
  };

  const handleSchedule = (id: string) => {
    void scheduleTask({ variables: { id } }).then((result) => {
      reportScheduleOutcome(result.data?.scheduleTask.status);
      refresh();
    });
  };

  const handleReschedule = (id: string, date: string) => {
    void (async () => {
      await updateTask({
        variables: {
          input: { id, dueAt: dueAtFromLocalDate(date) },
        },
      });

      const result = await scheduleTask({ variables: { id, date } });

      reportScheduleOutcome(result.data?.scheduleTask.status);
      refresh();
    })();
  };

  const handleAcceptAndSchedule = (id: string) => {
    void acceptProposed({ variables: { id } }).then(() =>
      scheduleTask({ variables: { id } }).then((result) => {
        reportScheduleOutcome(result.data?.scheduleTask.status);
        refresh();
      }),
    );
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
        onAcceptProposed={(id) => void acceptProposed({ variables: { id } }).then(refresh)}
        onDeclineProposed={(id) => void declineProposed({ variables: { id } }).then(refresh)}
        onAcceptAndSchedule={handleAcceptAndSchedule}
        onSchedule={handleSchedule}
        onReschedule={handleReschedule}
        pendingChangeId={pending?.id}
        pendingRationale={pending?.rationale}
        pendingKind={pending?.kind}
        onAcceptPending={(changeId) => void acceptPending({ variables: { id: changeId } }).then(refresh)}
        onDeclinePending={(changeId) => void declinePending({ variables: { id: changeId } }).then(refresh)}
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
        <TaskBoard sections={[]} renderTask={(task) => renderTree(task, 0)} />
        {showEmptyState ? (
          <EmptyState
            icon={<ListTodo size={48} />}
            message={<div>Nothing planned yet. Add your first task above.</div>}
          />
        ) : null}
      </>
    );
  } else {
    content = <TaskBoard sections={sections} renderTask={(task) => renderTree(task, 0)} />;
  }

  return (
    <>
      <PageContent>
        <div className="flex h-full min-h-0 w-full flex-col gap-6">
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
                  onClick={() => setFocusedTasks(selectedIds)}
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

      {focusedTasks && focusedTasks.length > 0 ? (
        <DeleteTaskModal
          taskIds={focusedTasks}
          onClose={() => {
            setFocusedTasks(null);
            setSelectedIds([]);
          }}
        />
      ) : null}
      {editingTask && (
        <EditTaskModal task={editingTask} onClose={() => setEditingTask(null)} onSaved={refresh} />
      )}
    </>
  );
}
