import { useMemo, useState, type ReactNode } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { EmptyState, LoadingPage, usePageTitle } from '@ci/common';
import { ListTodo } from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

import { DeleteTaskModal } from './DeleteTaskModal';
import { NewTaskForm } from './NewTaskForm';
import { Task } from './Task';
import { groupIntoSections, localDateOf, type SectionedTask } from './taskSections';

const GET_TASKS = gql(`
  query GetTasks($first: Int, $after: String) {
    tasks(first: $first, after: $after) {
      edges {
        node {
          id
          status
          priority
          dueAt
          scheduledFor
          deferUntil
          title
          ...TaskRowFragment
        }
      }
      totalCount
    }
  }
`);

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

export function PlanPage() {
  usePageTitle('Plan - Companion Intelligence');
  const { isFeatureEnabled } = useFeatures();
  const showEmptyState = isFeatureEnabled('planning.emptyState');

  const { data, loading, refetch } = useQuery(GET_TASKS, {
    variables: { first: 200 },
    // No subscriptions exist in this app, so a background refresh on revisit is
    // the closest thing to live data.
    fetchPolicy: 'cache-and-network',
  });

  const [completeTask] = useMutation(COMPLETE_TASK);
  const [reopenTask] = useMutation(REOPEN_TASK);
  const [focusedTask, setFocusedTask] = useState<string | null>(null);

  const nodes = useMemo(() => data?.tasks.edges.map((edge) => edge.node) ?? [], [data]);

  // "Today" is the viewer's local day, not the server's. Recomputed per render
  // rather than memoised on [] so an open tab rolls over at local midnight.
  const sections = useMemo(
    () => groupIntoSections(nodes as unknown as SectionedTask[], localDateOf(new Date())),
    [nodes],
  );

  const handleToggle = (id: string, done: boolean) => {
    void (done ? completeTask({ variables: { id } }) : reopenTask({ variables: { id } }));
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();

    setFocusedTask(id);
  };

  let content: ReactNode;

  // `cache-and-network` re-reports loading on every revisit, so only show the
  // spinner when there is genuinely nothing to render yet.
  if (loading && nodes.length === 0) {
    content = <LoadingPage />;
  } else if (nodes.length === 0) {
    content = showEmptyState ? (
      <EmptyState
        icon={<ListTodo size={48} />}
        message={<div>Nothing planned yet. Add your first task above.</div>}
      />
    ) : null;
  } else {
    content = (
      <div className="flex flex-col gap-6">
        {sections.map((section) => (
          <section key={section.key} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {section.label}
              <span className="ml-2 font-normal">{section.tasks.length}</span>
            </h2>

            <ul className="flex flex-col gap-2">
              {section.tasks.map((task) => (
                <Task key={task.id} task={task as never} onToggle={handleToggle} onDelete={handleDelete} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <>
      <PageContent>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <NewTaskForm onCreated={() => void refetch()} />

          {/* `relative` scopes the loading and empty states, both of which
              position themselves `absolute inset-0`. Without a positioned
              parent here they fill the whole column and sit on top of the form,
              swallowing clicks on Add. */}
          <div className="relative min-h-60 flex-1">{content}</div>
        </div>
      </PageContent>

      {focusedTask && <DeleteTaskModal taskId={focusedTask} onClose={() => setFocusedTask(null)} />}
    </>
  );
}
