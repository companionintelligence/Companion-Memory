import { useEffect, useId, useState } from 'react';

import { Button, Input, Label, Textarea, useToast } from '@ci/shadcn';
import { Pencil } from '@ci/shadcn/icons';

interface Props {
  label: string;
  /** The stored value. `null`/`''` renders the empty placeholder. */
  value: string | null | undefined;
  /** Saves this one field. Throw (or reject) to keep the editor open with the draft intact. */
  onSave: (value: string) => Promise<void>;
  multiline?: boolean;
  /** Placeholder for the input while editing. */
  placeholder?: string;
  /**
   * Changing this discards an in-progress edit — pass the entity id so
   * navigating between entities never carries a draft across.
   */
  resetKey?: string;
  /** Read-view class, e.g. to render the name as a heading. */
  valueClassName?: string;
}

/**
 * One field that reads as plain text until its pencil is clicked, then becomes
 * an input with Save / Cancel. Each field saves on its own, so fixing a typo in
 * the address never re-sends an untouched description.
 */
export function InlineEditableField({
  label,
  value,
  onSave,
  multiline = false,
  placeholder,
  resetKey,
  valueClassName,
}: Props) {
  const { toast } = useToast();
  const inputId = useId();
  const stored = value ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDraft(stored);
    // `stored` is deliberately not a dependency: a refetch that lands mid-edit
    // must not wipe what the user is typing. The draft is re-seeded on open.
  }, [resetKey]);

  const startEditing = () => {
    setDraft(stored);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(stored);
    setEditing(false);
  };

  const save = async () => {
    const next = draft.trim();
    if (next === stored.trim()) {
      setEditing(false);

      return;
    }

    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? `Couldn't save the ${label.toLowerCase()}: ${error.message}`
          : `Couldn't save the ${label.toLowerCase()}.`,
      );
    } finally {
      setSaving(false);
    }
  };

  const lower = label.toLowerCase();

  if (!editing) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label>{label}</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Edit ${lower}`}
            title={`Edit ${lower}`}
            onClick={startEditing}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        </div>
        {stored.trim() === '' ? (
          <p className="text-sm italic text-muted-foreground">No {lower} yet</p>
        ) : (
          <p className={valueClassName ?? 'whitespace-pre-wrap text-sm'}>{stored}</p>
        )}
      </div>
    );
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && !multiline) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      {multiline ? (
        <Textarea
          id={inputId}
          value={draft}
          autoFocus
          disabled={saving}
          placeholder={placeholder ?? `Add a ${lower}…`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-[120px]"
        />
      ) : (
        <Input
          id={inputId}
          value={draft}
          autoFocus
          disabled={saving}
          placeholder={placeholder ?? `Add a ${lower}…`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
