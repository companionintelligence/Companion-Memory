import { useCallback, useEffect, useRef, useState } from 'react';

import { useMutation } from '@apollo/client';
import { Button, Dialog, Input, Label, Textarea, useToast } from '@ci/shadcn';

import { gql } from '@/graphql';

export type EditableTask = {
  id: string;
  title: string;
  description?: string | null;
  dueAt?: string | null;
  estimatedMinutes?: number | null;
};

interface Props {
  task: EditableTask;
  onClose: () => void;
  onSaved?: () => void;
}

export const UPDATE_TASK = gql(`
  mutation UpdateTask($input: UpdateTaskInput!) {
    updateTask(input: $input) {
      success
      task {
        id
        ...TaskRowFragment
      }
    }
  }
`);

const SAVE_MS = 450;

/**
 * Why closing needs three answers and not two: a refusal to save is not one
 * thing. `invalid` is the user's own draft asking to be fixed, and the inline
 * error is the whole reason to hold the dialog open. `failed` is the network or
 * the server — the draft is fine, so closing would destroy good work, but the
 * user still has to be able to leave, which is why that state grows its own
 * pair of exits rather than just refusing.
 */
type PersistResult = 'saved' | 'invalid' | 'failed';

const SAVE_FAILED = "That task couldn't be saved. Your changes are still here.";
const RETRY_REFUSED = 'Nothing was sent — fix the problem above, then try again.';

type Draft = {
  title: string;
  description: string;
  dueDate: string;
  estimated: string;
};

function toDateInput(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function dueAtFromInput(value: string): string | null {
  if (!value) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);

  if (!year || !month || !day) {
    return null;
  }

  return new Date(year, month - 1, day, 12).toISOString();
}

function draftFromTask(task: EditableTask): Draft {
  return {
    title: task.title,
    description: task.description ?? '',
    dueDate: toDateInput(task.dueAt),
    estimated: task.estimatedMinutes != null ? String(task.estimatedMinutes) : '',
  };
}

function draftsEqual(left: Draft, right: Draft): boolean {
  return (
    left.title === right.title &&
    left.description === right.description &&
    left.dueDate === right.dueDate &&
    left.estimated === right.estimated
  );
}

function validateDraft(draft: Draft): string | null {
  if (!draft.title.trim()) {
    return 'A title is required.';
  }

  const minutes = draft.estimated.trim() ? Number(draft.estimated) : null;

  if (minutes != null && (!Number.isFinite(minutes) || minutes < 1)) {
    return 'Estimated minutes must be a positive number.';
  }

  return null;
}

function inputFromDraft(id: string, draft: Draft) {
  const minutes = draft.estimated.trim() ? Number(draft.estimated) : null;

  return {
    id,
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    dueAt: dueAtFromInput(draft.dueDate),
    estimatedMinutes: minutes,
  };
}

export function EditTaskModal({ task, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftFromTask(task));
  const [error, setError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [closeRefused, setCloseRefused] = useState(false);
  const [retryRefused, setRetryRefused] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [updateTask] = useMutation(UPDATE_TASK, { errorPolicy: 'all' });
  const { toast } = useToast();
  const lastSaved = useRef<Draft>(draftFromTask(task));
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const attempt = useRef(0);
  const persistRef = useRef<(next: Draft) => Promise<PersistResult>>(async () => 'failed');

  const persist = useCallback(
    async (next: Draft): Promise<PersistResult> => {
      const invalid = validateDraft(next);

      if (invalid) {
        setError(invalid);
        setStatus('idle');

        return 'invalid';
      }

      // Only the newest attempt may report an outcome. Two persists overlap
      // whenever the user presses Done with an autosave still in flight, and
      // the older one resolving last used to leave `saveFailed` describing a
      // save nobody is waiting on any more. The counter is bumped on the
      // nothing-to-send path too, so reverting to the saved values also retires
      // whatever is in flight — otherwise its failure would raise the panel
      // over a draft that already matches the server.
      const seq = ++attempt.current;
      const isCurrent = () => seq === attempt.current;

      setError(null);
      setSaveFailed(false);
      setCloseRefused(false);

      if (draftsEqual(next, lastSaved.current)) {
        return 'saved';
      }

      setStatus('saving');

      try {
        const { data } = await updateTask({
          variables: { input: inputFromDraft(task.id, next) },
        });

        // The write is the source of truth. Apollo can still throw field errors
        // on the returned task; those used to surface as "couldn't be saved"
        // after the title was already on the server.
        if (!data?.updateTask.success) {
          if (isCurrent()) {
            setSaveFailed(true);
            setStatus('idle');
          }

          return 'failed';
        }

        if (!isCurrent()) {
          // Superseded: reporting now would clear a newer attempt's failure and
          // rewind `lastSaved` to this attempt's older draft.
          return 'saved';
        }

        lastSaved.current = next;
        setStatus('saved');
        onSaved?.();

        return 'saved';
      } catch {
        if (isCurrent()) {
          setSaveFailed(true);
          setStatus('idle');
        }

        return 'failed';
      }
    },
    [onSaved, task.id, updateTask],
  );

  persistRef.current = persist;

  useEffect(() => {
    const invalid = validateDraft(draft);

    if (invalid) {
      setError(invalid);
      setStatus('idle');

      return;
    }

    if (draftsEqual(draft, lastSaved.current)) {
      // Typing the original values back leaves the failed save nothing to
      // protect, so the notice — and the close it holds up — goes with it.
      // Bump the supersession counter too, the same as persist()'s own
      // nothing-to-send path: this retires any attempt still in flight so a
      // late failure can't land `saveFailed` over a draft that already
      // matches the server.
      attempt.current += 1;
      setSaveFailed(false);
      setCloseRefused(false);

      return;
    }

    setError(null);
    const timer = window.setTimeout(() => {
      void persistRef.current(draft);
    }, SAVE_MS);

    return () => window.clearTimeout(timer);
  }, [draft]);

  /**
   * ═══ CLOSING THREW THE EDIT AWAY; THEN IT TRAPPED THE USER ═══
   *
   * Two earlier shapes, both wrong. Closing on any refusal unmounted the dialog
   * with the user's work inside it. Holding it open on any refusal then locked
   * an offline user in — Done, Escape, the backdrop and shadcn's X all funnel
   * through this one handler, so a failing network became a dialog with no exit
   * but a page reload.
   *
   * The way out of both is that a failed save is a state, not a verdict on the
   * close. It keeps the dialog open with the draft intact, and it puts the
   * decision the user actually has — retry, or throw this away — on screen as
   * two labelled buttons. A close attempt made while that state is up must not
   * be swallowed in silence, or the dialog just looks broken: it points the
   * user at those two exits instead.
   */
  const handleClose = async () => {
    if (saveFailed) {
      setCloseRefused(true);
      discardRef.current?.focus();

      return;
    }

    const result = await persistRef.current(draft);

    // 'invalid' holds open behind its inline error; 'failed' holds open behind
    // the retry/discard pair `persist` just raised.
    if (result !== 'saved') {
      return;
    }

    onClose();
  };

  // A retry the draft's own contents refuse has to say so, or the button reads
  // as dead: the failure panel is already on screen and clicking changes
  // nothing visible without this.
  const handleRetry = async () => {
    const result = await persistRef.current(draft);

    setRetryRefused(result === 'invalid');
  };

  const handleDiscard = () => {
    toast.error('Those changes were discarded — the task is unchanged.');
    onClose();
  };

  const patch = (partial: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...partial }));
    setStatus('idle');
    setRetryRefused(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && void handleClose()}>
      <Dialog.Content
        className="overflow-x-hidden sm:max-w-[425px]"
        // The title used to take `autoFocus`, which focuses it and leaves the
        // caret wherever the engine put it — position 0 on iOS, so a keystroke
        // straight after opening landed IN FRONT of the title. Opening a task
        // to edit its title means appending to it, so focus it here and park
        // the caret after the last character.
        onOpenAutoFocus={(event) => {
          event.preventDefault();

          const title = titleRef.current;

          if (!title) {
            return;
          }

          title.focus();
          title.setSelectionRange(title.value.length, title.value.length);
        }}
      >
        <Dialog.Header>
          <Dialog.Title>Edit task</Dialog.Title>
          <Dialog.Description>Changes save as you type. Close when you are done.</Dialog.Description>
        </Dialog.Header>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="edit-task-title">Title</Label>
            <Textarea
              id="edit-task-title"
              ref={titleRef}
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              rows={4}
              className="field-sizing-fixed min-h-20 min-w-0 resize-y break-all"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="edit-task-description">Notes</Label>
            <Textarea
              id="edit-task-description"
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
              rows={3}
              className="field-sizing-fixed min-w-0 break-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-task-due">Due</Label>
              <Input
                id="edit-task-due"
                type="date"
                // WebKit sizes a native date control's `width: 100%` as the
                // CONTENT box and adds its padding and border on top — 26pt too
                // wide for this grid cell, which put the field over Minutes on
                // iOS. `min-w-0` and the grid cannot help; an ordinary box can.
                className="pointer-coarse:appearance-none"
                value={draft.dueDate}
                onChange={(e) => patch({ dueDate: e.target.value })}
              />
              {/* A native date input has no dependable way to be emptied: on
                  iOS the picker's Reset puts back the value it opened with, so
                  a due date, once set, could never be removed. */}
              {draft.dueDate ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => patch({ dueDate: '' })}
                >
                  Clear due date
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-task-estimate">Minutes</Label>
              <Input
                id="edit-task-estimate"
                type="number"
                min={1}
                inputMode="numeric"
                value={draft.estimated}
                onChange={(e) => patch({ estimated: e.target.value })}
              />
            </div>
          </div>

          {/*
            Both refusals can be live at once — the last save failed AND the
            draft has since gone invalid — so the panel states both rather than
            letting the failure hide the validation error, which used to leave a
            retry refusing for a reason that was never on screen. The validation
            line comes first: it is the one blocking the retry, so it is the one
            the user can act on.
          */}
          {saveFailed || error ? (
            <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
              {error ? <p>{error}</p> : null}
              {saveFailed ? <p>{SAVE_FAILED}</p> : null}
              {saveFailed && closeRefused ? (
                <p>Nothing is saved yet — try again, or discard your changes to close.</p>
              ) : null}
              {error && retryRefused ? <p>{RETRY_REFUSED}</p> : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ' '}
            </p>
          )}

          <Dialog.Footer>
            {saveFailed ? (
              <>
                <Button ref={discardRef} type="button" variant="outline" onClick={handleDiscard}>
                  Discard changes and close
                </Button>
                <Button type="button" onClick={() => void handleRetry()}>
                  Try again
                </Button>
              </>
            ) : (
              <Button type="button" onClick={() => void handleClose()}>
                Done
              </Button>
            )}
          </Dialog.Footer>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
