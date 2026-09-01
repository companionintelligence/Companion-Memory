import { useRef, useState } from 'react';

import { useMutation } from '@apollo/client';
import { Button, Input } from '@ci/shadcn';
import { Plus } from '@ci/shadcn/icons';

import { gql } from '@/graphql';

const CREATE_TASK = gql(`
  mutation CreateTask($input: CreateTaskInput!) {
    createTask(input: $input) {
      success
      task {
        id
        ...TaskRowFragment
      }
    }
  }
`);

interface Props {
  /** Called after a successful create so the list can refresh. */
  onCreated: () => void;
}

export function NewTaskForm({ onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createTask, { loading }] = useMutation(CREATE_TASK);
  const inputRef = useRef<HTMLInputElement>(null);

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const trimmed = title.trim();

    if (!trimmed) {
      return;
    }

    setError(null);

    try {
      const { data } = await createTask({ variables: { input: { title: trimmed } } });

      // The resolver reports a refused write as `success: false` rather than
      // throwing, so a thrown error and a falsy payload both need handling.
      if (!data?.createTask.success) {
        setError("That task couldn't be saved. Try again.");
        restoreFocus();

        return;
      }

      setTitle('');
      onCreated();
      restoreFocus();
    } catch {
      setError("That task couldn't be saved. Try again.");
      restoreFocus();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs doing?"
          aria-label="New task title"
          disabled={loading}
        />
        <Button type="submit" disabled={loading || title.trim().length === 0}>
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
