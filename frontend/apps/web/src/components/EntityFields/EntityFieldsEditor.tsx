import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { Input, Label, Textarea, useToast } from '@ci/shadcn';

/** A single editable field rendered read-only or as an input depending on edit mode. */
export interface EditField {
  key: string;
  label: string;
  /** Current (saved) value, used for read-only display and to seed the editor. */
  value: string;
  multiline?: boolean;
  inputType?: string;
  placeholder?: string;
  /** Omit this field from the read-only view when `value` is empty. */
  hideWhenEmpty?: boolean;
}

/** A read-only label/value pair shown alongside the editable fields. */
export interface MetaItem {
  label: string;
  value: ReactNode;
}

interface EditorOptions {
  fields?: EditField[];
  /** When provided, an edit affordance appears and these values are persisted on save. */
  onSave?: (values: Record<string, string>) => Promise<void> | void;
  /** Whether the surface is currently in edit mode (owned by the caller). */
  editing: boolean;
  /**
   * Changes when the surface switches to a different entity, so an in-progress
   * edit can never be persisted onto the entity that replaced it.
   */
  resetKey?: string;
}

export interface EntityFieldsEditorState {
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  saving: boolean;
  saveError: string | null;
  /**
   * Persists the current values. Resolves `true` when the write succeeded, or
   * when nothing was changed and so nothing was written.
   */
  save: () => Promise<boolean>;
  /** Discards the buffer, restoring the persisted values. */
  reset: () => void;
}

/**
 * Edit-buffer state for a set of {@link EditField}s.
 *
 * Extracted from the memory drawer's `EntityDetailScaffold` so the full-page
 * entity views can offer the same field set and the same save semantics
 * instead of the description-only editor they used to be limited to. The
 * drawer and the pages lay the fields out differently (sheet footer vs. card
 * footer), so the layout stays with each caller and only the behaviour — seed,
 * buffer, save, roll back — is shared.
 */
export function useEntityFieldsEditor({ fields, onSave, editing, resetKey }: EditorOptions) {
  const { toast } = useToast();

  // The current persisted values, rebuilt from the caller's props every render
  // so external cache updates are always reflected (read-only display + edit
  // seeding).
  const liveValues = useMemo(() => {
    const next: Record<string, string> = {};

    for (const field of fields ?? []) {
      next[field.key] = field.value ?? '';
    }

    return next;
  }, [fields]);

  const [values, setValues] = useState<Record<string, string>>(liveValues);
  // What the buffer was last seeded with. Save judges an edit against this,
  // not against `liveValues`: a value that landed from elsewhere while the
  // buffer was open (the drawer writes straight into the Apollo cache) is not
  // something the user changed, and writing the seed back would revert it.
  const [seeded, setSeeded] = useState<Record<string, string>>(liveValues);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Seed the buffer from the latest persisted values each time edit mode opens,
  // so a stale buffer can't clobber an update that landed while it was closed.
  const [wasEditing, setWasEditing] = useState(editing);

  if (wasEditing !== editing) {
    setWasEditing(editing);

    if (editing) {
      setValues(liveValues);
      setSeeded(liveValues);
      setSaveError(null);
    }
  }

  // Abandon any in-progress edit when the entity changes.
  const [activeKey, setActiveKey] = useState(resetKey);

  if (activeKey !== resetKey) {
    setActiveKey(resetKey);
    setValues(liveValues);
    setSeeded(liveValues);
    setSaving(false);
    setSaveError(null);
  }

  const setValue = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => {
    setValues(liveValues);
    setSeeded(liveValues);
    setSaveError(null);
  }, [liveValues]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!onSave) {
      return false;
    }

    // Nothing was changed, so closing edit mode is all Save has to do. Writing
    // the stored values back reached Change History as an edit: the event page's
    // unchanged title, saved next to its description, read as a rename.
    if (Object.keys(values).every((key) => values[key] === seeded[key])) {
      return true;
    }

    setSaving(true);
    setSaveError(null);

    try {
      await onSave(values);

      return true;
    } catch (error) {
      // Keep the buffer intact so the user can retry without retyping.
      const message = error instanceof Error && error.message ? error.message : 'Failed to save changes.';

      setSaveError(message);
      toast.error(message);

      return false;
    } finally {
      setSaving(false);
    }
  }, [onSave, seeded, toast, values]);

  const state: EntityFieldsEditorState = { values, setValue, saving, saveError, save, reset };

  return state;
}

interface FieldsProps {
  fields: EditField[];
  editing: boolean;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Disambiguates the generated input ids when two editors share a page. */
  idPrefix?: string;
}

/**
 * The label/value list for a set of {@link EditField}s — static text when
 * closed, inputs when open. Shared by the memory drawer and the full-page
 * entity views so both render (and edit) the same fields.
 */
export function EntityFields({ fields, editing, values, onChange, idPrefix = 'field' }: FieldsProps) {
  const visible = editing ? fields : fields.filter((field) => !field.hideWhenEmpty || Boolean(field.value));

  if (visible.length === 0) {
    return null;
  }

  return (
    <>
      {visible.map((field) => {
        const id = `${idPrefix}-${field.key}`;

        return (
          <div key={field.key} className="flex flex-col gap-2">
            <Label htmlFor={editing ? id : undefined}>{field.label}</Label>
            {editing ? (
              field.multiline ? (
                <Textarea
                  id={id}
                  value={values[field.key] ?? ''}
                  placeholder={field.placeholder}
                  className="min-h-[100px]"
                  onChange={(event) => onChange(field.key, event.target.value)}
                />
              ) : (
                <Input
                  id={id}
                  type={field.inputType ?? 'text'}
                  value={values[field.key] ?? ''}
                  placeholder={field.placeholder}
                  onChange={(event) => onChange(field.key, event.target.value)}
                />
              )
            ) : field.value ? (
              <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{field.value}</p>
            ) : (
              <p className="text-sm italic text-muted-foreground">—</p>
            )}
          </div>
        );
      })}
    </>
  );
}

interface MetaListProps {
  items: MetaItem[];
}

/** The read-only label/value rows the drawer shows under "Details". */
export function EntityMetaList({ items }: MetaListProps) {
  const visible = items.filter(
    (item) => item.value !== null && item.value !== undefined && item.value !== '',
  );

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col divide-y divide-border/50">
      {visible.map((item) => (
        <div key={item.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0">
          <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
            {item.label}
          </span>
          <span className="min-w-0 break-words text-sm">{item.value}</span>
        </div>
      ))}
    </div>
  );
}
