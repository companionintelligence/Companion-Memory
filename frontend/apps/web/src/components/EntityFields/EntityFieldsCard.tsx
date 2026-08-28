import { type ReactNode } from 'react';

import { Button, Card, cn } from '@ci/shadcn';
import { Loader2 } from '@ci/shadcn/icons';

import {
  EntityFields,
  EntityMetaList,
  useEntityFieldsEditor,
  type EditField,
  type MetaItem,
} from './EntityFieldsEditor';

interface Props {
  /** Card heading. */
  title?: string;
  /** The same field set the memory drawer offers for this entity type. */
  fields?: EditField[];
  /** Read-only rows shown under the fields (timestamps, source, type…). */
  metaItems?: MetaItem[];
  /** Whether the page is in edit mode — driven by the page's `EntityEditToggle`. */
  editMode: boolean;
  /** Omit for a read-only card: the fields then render as static text. */
  onSave?: (values: Record<string, string>) => Promise<void>;
  /** Called with `false` once a save or a cancel finishes, to close edit mode. */
  onEditModeChange?: (editMode: boolean) => void;
  /** Changes when the page switches entity, discarding any in-progress edit. */
  resetKey?: string;
  /** Extra read-only content rendered above the fields (media, say). */
  children?: ReactNode;
  className?: string;
}

/**
 * The editable summary of an entity on its full page.
 *
 * Full-page entity views used to expose strictly less than the memory drawer
 * for the same object — usually description-only, with the title, the
 * timestamps and every type-specific field either read-only or absent. This
 * card renders the drawer's own `editFields` / `onSave` contract (shared via
 * {@link useEntityFieldsEditor}) so anyone landing on the route directly gets an
 * editor that can do at least as much as the drawer for the same object.
 */
export function EntityFieldsCard({
  title = 'Details',
  fields,
  metaItems,
  editMode,
  onSave,
  onEditModeChange,
  resetKey,
  children,
  className,
}: Props) {
  const editable = Boolean(onSave && fields && fields.length > 0);
  const editing = editMode && editable;
  const { values, setValue, saving, saveError, save, reset } = useEntityFieldsEditor({
    fields,
    onSave,
    editing,
    resetKey,
  });

  const handleSave = async () => {
    if (await save()) {
      onEditModeChange?.(false);
    }
  };

  const handleCancel = () => {
    reset();
    onEditModeChange?.(false);
  };

  return (
    <Card className={cn('p-0', className)}>
      <Card.Header className="p-4 pb-0">
        <Card.Title className="text-sm">{title}</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4 p-4">
        {children}

        <EntityFields
          fields={fields ?? []}
          editing={editing}
          values={values}
          onChange={setValue}
          idPrefix={resetKey ? `page-field-${resetKey}` : 'page-field'}
        />

        {metaItems && metaItems.length > 0 && <EntityMetaList items={metaItems} />}

        {editing && (
          <div className="flex flex-col gap-2">
            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}
            <div className="flex flex-row justify-end gap-2">
              <Button variant="outline" onClick={handleCancel} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving} className={cn(saving && 'opacity-80')}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
