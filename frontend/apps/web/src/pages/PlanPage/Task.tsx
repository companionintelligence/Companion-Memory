import { Button, Checkbox } from '@ci/shadcn';
import { Trash } from '@ci/shadcn/icons';

import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';

interface Props {
  task: FragmentType<typeof TaskRowFragment>;
  onToggle: (id: string, done: boolean) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
}

export const TaskRowFragment = gql(`
  fragment TaskRowFragment on TaskType {
    id
    title
    description
    status
    priority
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

/** `2026-01-15T17:00:00Z` -> `Jan 15`, in the viewer's own zone. */
function formatDue(dueAt: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(dueAt));
}

export function Task({ task: taskMasked, onToggle, onDelete }: Props) {
  const task = useFragment(TaskRowFragment, taskMasked);
  const done = task.status === 'done';
  const priorityLabel = PRIORITY_LABELS[task.priority];

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm transition-shadow hover:shadow-md">
      <Checkbox
        className="mt-1"
        checked={done}
        onCheckedChange={(checked) => onToggle(task.id, checked === true)}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`truncate font-medium ${done ? 'text-muted-foreground line-through' : ''}`}>
          {task.title}
        </span>

        {task.description ? (
          <span className="line-clamp-2 text-sm text-muted-foreground">{task.description}</span>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {task.dueAt ? <span>Due {formatDue(task.dueAt as string)}</span> : null}
          {task.scheduledFor ? <span>Planned {task.scheduledFor}</span> : null}
          {task.estimatedMinutes ? <span>{task.estimatedMinutes} min</span> : null}
          {priorityLabel ? <span>{priorityLabel}</span> : null}
        </div>
      </div>

      <Button
        onClick={(e) => onDelete(e, task.id)}
        size="icon"
        variant="ghost"
        aria-label={`Delete ${task.title}`}
      >
        <Trash className="h-4 w-4" />
      </Button>
    </li>
  );
}
