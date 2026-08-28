import { type ReactNode, useEffect, useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Card, Label, Textarea, cn, useToast } from '@ci/shadcn';

import { useTagEntityService } from '@/api';
import { TagInput } from '@/components/TagInput';

/**
 * The Tags + free-text panel in every entity page's sidebar.
 *
 * Previously copy-pasted across all seven entity pages, each with the same two defects: an entity
 * with nothing recorded rendered an empty bordered box and a blank 120px textarea — chrome that
 * looks broken rather than empty — and the textarea was uncontrolled with no save handler, so edits
 * were silently discarded on navigate.
 */
/** The resource types `GlobalUID` knows about. Not exported from @ci/common, so derived here. */
type ResourceType = Parameters<typeof GlobalUID.encode>[0];

interface Props {
  /** Entity type for `GlobalUID.encode` — 'person', 'place', 'item', … */
  entityType: ResourceType;
  /** Raw (un-encoded) entity uuid from the route. */
  entityId: string;
  /** Resets the tag editor's internal state when the page switches entity. */
  resetKey: string;
  tags: string[];
  description: string | null | undefined;
  /** What the free-text field is called here: 'Description', 'Text', 'Summary'. */
  descriptionLabel?: string;
  editMode: boolean;
  /**
   * Persists an edited description. Omit for entity types with no write path for the field — it then
   * stays read-only even in edit mode, rather than accepting edits it cannot keep.
   */
  onDescriptionSave?: (value: string) => Promise<void>;
  /**
   * Leave the description out entirely — for a page that edits it elsewhere
   * (e.g. PlacePage's per-field editor) and only wants the tags here.
   */
  hideDescription?: boolean;
  /** Type-specific detail rendered above Tags — an event's organizer and location, say. */
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function EntityTagsDescriptionCard({
  entityType,
  entityId,
  resetKey,
  tags,
  description,
  descriptionLabel = 'Description',
  editMode,
  onDescriptionSave,
  hideDescription = false,
  children,
  className,
  contentClassName,
}: Props) {
  const { tagEntities, untagEntities } = useTagEntityService();
  const { toast } = useToast();

  // How many tags the entity has, tracked locally as well as from the prop: an add or a remove has
  // to flip the placeholder immediately, or leaving edit mode shows the empty bordered box this
  // component exists to replace until the page's query catches up.
  const [tagCount, setTagCount] = useState(tags.length);
  const [draft, setDraft] = useState(description ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTagCount(tags.length);
  }, [tags.length]);

  // A new entity, or a description changed elsewhere, replaces the draft. In practice this fires
  // after our own save, normalising the box to exactly what was stored. It would also discard an
  // in-progress edit if the value changed underneath us, which is the right trade while nothing on
  // these pages polls: showing stale text as if it were saved is the worse failure.
  useEffect(() => {
    setDraft(description ?? '');
  }, [description, resetKey]);

  const globalId = GlobalUID.encode(entityType, entityId);
  const canEditDescription = editMode && onDescriptionSave != null;
  const descriptionFieldId = `description-${resetKey}`;
  const showDescriptionPlaceholder = !editMode && draft.trim() === '';

  const handleDescriptionBlur = async () => {
    const next = draft.trim();
    if (!onDescriptionSave || next === (description ?? '').trim()) {
      return;
    }

    setSaving(true);
    try {
      await onDescriptionSave(next);
    } catch {
      toast.error(`Couldn't save the ${descriptionLabel.toLowerCase()}.`);
      setDraft(description ?? '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className={cn('p-0', className)}>
      <Card.Content className={cn('p-4 flex flex-col gap-6', contentClassName)}>
        {children}

        <div className="space-y-2">
          <Label>Tags</Label>

          {!editMode && tagCount === 0 ? (
            <p className="text-sm italic text-muted-foreground">No tags yet</p>
          ) : (
            <TagInput
              key={resetKey}
              tags={tags}
              readOnly={!editMode}
              onTagAdded={async (label) => {
                try {
                  await tagEntities([globalId], [label]);
                  setTagCount((count) => count + 1);

                  return true;
                } catch {
                  toast.error(`Couldn't add tag “${label}”.`);

                  return false;
                }
              }}
              onTagRemoved={async (label) => {
                try {
                  await untagEntities([globalId], [label]);
                  setTagCount((count) => Math.max(0, count - 1));

                  return true;
                } catch {
                  // TagInput removes optimistically and restores only on an explicit `false`.
                  // Swallowing this would leave the tag gone from the screen but still on the
                  // entity — the UI quietly disagreeing with the server.
                  toast.error(`Couldn't remove tag “${label}”.`);

                  return false;
                }
              }}
            />
          )}
        </div>

        {!hideDescription && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              {/*
              `htmlFor` only when the control it names is actually rendered. The empty state
              replaces the textarea with static text, and a label pointing at an id that is not in
              the document is announced by a screen reader as labelling nothing.
            */}
              <Label htmlFor={showDescriptionPlaceholder ? undefined : descriptionFieldId}>
                {descriptionLabel}
              </Label>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {saving ? 'Saving…' : ''}
              </span>
            </div>

            {showDescriptionPlaceholder ? (
              <p className="text-sm italic text-muted-foreground">No {descriptionLabel.toLowerCase()} yet</p>
            ) : (
              <Textarea
                id={descriptionFieldId}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={handleDescriptionBlur}
                readOnly={!canEditDescription}
                placeholder={canEditDescription ? `Add a ${descriptionLabel.toLowerCase()}…` : undefined}
                className={cn(
                  'resize-none min-h-[120px]',
                  canEditDescription ? '' : 'shadow-none focus-visible:ring-0 focus-visible:border-border',
                )}
              />
            )}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
