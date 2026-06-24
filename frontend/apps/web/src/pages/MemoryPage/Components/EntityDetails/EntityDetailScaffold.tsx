import { type ReactNode, useMemo, useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Button, Card, Input, Label, Sheet, Textarea, cn, useToast } from '@ci/shadcn';
import { Loader2, Pencil } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { useTagEntityService } from '@/api';
import {
  EntityRelationshipCards,
  getEntityDetailPath,
  toGlobalResourceType,
} from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { TagInput } from '@/components/TagInput';

import type { MemoryEntity } from '../../../MemoryPage/useEntityService';

/** A single editable field rendered read-only or as an input depending on edit mode. */
export interface EditField {
  key: string;
  label: string;
  /** Current (saved) value, used for read-only display and to seed the editor. */
  value: string;
  multiline?: boolean;
  inputType?: string;
  placeholder?: string;
}

/** A read-only label/value pair shown in the metadata card. */
export interface MetaItem {
  label: string;
  value: ReactNode;
}

interface EntityDetailScaffoldProps {
  entity: MemoryEntity;
  title: string;
  subtitle?: ReactNode;
  /** Media (image/video) rendered at the top, above everything else. */
  media?: ReactNode;
  /** Extra read-only content rendered under the media (e.g. a content snippet). */
  children?: ReactNode;
  /** Structured read-only sections rendered after the editable summary fields. */
  detailSections?: ReactNode;
  metaItems?: MetaItem[];
  editFields?: EditField[];
  /** When provided, an edit affordance appears and these values are persisted on save. */
  onSave?: (values: Record<string, string>) => Promise<void> | void;
  /** Raw record rendered in a collapsible JSON <details>. */
  rawData?: unknown;
  /** Whether the entity supports tag editing (renders a TagInput bound to its global id). */
  taggable?: boolean;
  /**
   * Allow tags to be edited even without field editing — opens an edit affordance
   * driven purely by tags. Used by graph-node drawers (GenericDetails) so they
   * reach tag parity with the same entity opened from list/gallery/map, while
   * read-only fallbacks keep their tags read-only.
   */
  tagsEditable?: boolean;
}

interface EntityRef {
  resourceType: string | null;
  rawId: string | null;
  globalId: string | null;
}

/**
 * Resolve the per-entity ids the drawer needs: the graph `rawId` (for related
 * entities + deep links) and the GraphQL `globalId` (for tag mutations). Search
 * results carry a GlobalUID-encoded id; graph nodes (GenericEntity) carry a raw
 * graph entity id and their own type string.
 */
function resolveEntityRef(entity: MemoryEntity): EntityRef {
  if (entity.__typename === 'GenericEntity') {
    // Reconstruct the GraphQL global id for known taggable node types so a
    // graph-node drawer can read/edit tags like the same entity opened from
    // list/gallery/map (mirrors EntityRelationshipCards' GlobalUID.encode).
    const globalType = entity.entityType ? toGlobalResourceType(entity.entityType) : null;

    return {
      resourceType: entity.entityType ? entity.entityType.toLowerCase().replace(/_/g, '-') : null,
      rawId: entity.id ?? null,
      globalId: globalType && entity.id ? GlobalUID.encode(globalType, entity.id) : null,
    };
  }

  try {
    const { type, id } = GlobalUID.decode(entity.id);

    return { resourceType: type, rawId: id, globalId: entity.id };
  } catch {
    return { resourceType: null, rawId: entity.id ?? null, globalId: entity.id ?? null };
  }
}

/** Best-effort read of tag labels carried in a graph node's free-form properties. */
function readTagsFromProperties(properties: Record<string, unknown> | null | undefined): string[] {
  if (!properties) {
    return [];
  }

  for (const key of ['tags', 'tagLabels', 'tag_labels', 'tagNames', 'tag_names']) {
    const value = properties[key];

    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((label): label is string => label.length > 0);
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return value
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label.length > 0);
    }
  }

  return [];
}

function readTags(entity: MemoryEntity): string[] {
  if (entity.__typename === 'GenericEntity') {
    return readTagsFromProperties(entity.properties);
  }

  const tags = (entity as { tags?: Array<{ label?: string | null } | null> | null }).tags;

  if (!Array.isArray(tags)) {
    return [];
  }

  return tags.map((tag) => tag?.label?.trim() ?? '').filter((label): label is string => label.length > 0);
}

/** Prefix relative storage paths with `/static`; pass absolute/data URLs through. */
export function resolveStaticUrl(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return /^https?:\/\//.test(value) || value.startsWith('data:') ? value : `/static${value}`;
}

/**
 * Render image/video media for a media-bearing entity. `src` should already be
 * resolved to a loadable URL (callers add the `/static` prefix where needed).
 * Falls back to treating an unknown content type as an image.
 */
export function EntityMedia({
  src,
  contentType,
  alt,
}: {
  src?: string | null;
  contentType?: string | null;
  alt?: string;
}) {
  if (!src) {
    return null;
  }

  const isVideo = contentType?.startsWith('video/') ?? false;
  const isImage = contentType ? contentType.startsWith('image/') : true;

  if (!isVideo && !isImage) {
    return null;
  }

  return (
    <div className="flex items-center justify-center overflow-hidden rounded-md border bg-muted/40">
      {isVideo ? (
        <video src={src} controls className="max-h-[45vh] w-full object-contain" />
      ) : (
        <img src={src} alt={alt ?? ''} className="max-h-[45vh] w-full object-contain" />
      )}
    </div>
  );
}

function RawDataDetails({ data }: { data: unknown }) {
  const pretty = useMemo(() => {
    try {
      const json = JSON.stringify(data, null, 2);

      return json && json !== '{}' && json !== 'null' && json !== '[]' ? json : null;
    } catch {
      return null;
    }
  }, [data]);

  if (!pretty) {
    return null;
  }

  return (
    <details className="rounded-xl border border-border/60 bg-card/45 shadow-sm backdrop-blur">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Raw data
      </summary>
      <pre className="max-h-72 overflow-auto px-4 pb-4 text-xs leading-relaxed text-foreground/85">
        {pretty}
      </pre>
    </details>
  );
}

export function EntityDetailScaffold({
  entity,
  title,
  subtitle,
  media,
  children,
  detailSections,
  metaItems,
  editFields,
  onSave,
  rawData,
  taggable = false,
  tagsEditable = false,
}: EntityDetailScaffoldProps) {
  const ref = useMemo(() => resolveEntityRef(entity), [entity]);
  const currentTags = useMemo(() => readTags(entity), [entity]);
  const { tagEntities, untagEntities } = useTagEntityService();
  const { toast } = useToast();

  const canEdit = Boolean(onSave && editFields && editFields.length > 0);
  // Tags-only edit mode: no persisted fields, just an editable TagInput. Lets
  // graph-node drawers manage tags without the field-editing wiring.
  const canManageTags = Boolean(tagsEditable && taggable && ref.globalId);
  const canEnterEditMode = canEdit || canManageTags;

  // The current persisted values, rebuilt from props every render so external
  // cache updates are always reflected (read-only display + edit seeding).
  const liveValues = useMemo(() => {
    const next: Record<string, string> = {};

    for (const field of editFields ?? []) {
      next[field.key] = field.value ?? '';
    }

    return next;
  }, [editFields]);

  const [values, setValues] = useState<Record<string, string>>(liveValues);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Abandon any in-progress edit when the open entity changes (by id), so one
  // entity's edits can never be persisted onto another.
  const entityKey = ref.globalId ?? ref.rawId ?? '';
  const [activeKey, setActiveKey] = useState(entityKey);
  if (activeKey !== entityKey) {
    setActiveKey(entityKey);
    setEditing(false);
    setSaving(false);
    setSaveError(null);
  }

  const startEditing = () => {
    // Seed the editor from the latest persisted values each time we enter edit
    // mode so a stale buffer can't clobber an external update.
    setValues(liveValues);
    setSaveError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    if (!onSave) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      await onSave(values);
      setEditing(false);
    } catch (error) {
      // Keep editing open so the user can retry without losing their changes.
      const message = error instanceof Error && error.message ? error.message : 'Failed to save changes.';

      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setValues(liveValues);
    setEditing(false);
    setSaveError(null);
  };

  const detailPath = ref.resourceType && ref.rawId ? getEntityDetailPath(ref.resourceType, ref.rawId) : null;

  const visibleMeta = (metaItems ?? []).filter(
    (item) => item.value !== null && item.value !== undefined && item.value !== '',
  );

  return (
    <Sheet.Content className="z-[1000] w-full gap-0 overflow-hidden border-l border-white/10 bg-background/75 p-0 shadow-2xl backdrop-blur-2xl supports-[backdrop-filter]:bg-background/65 sm:max-w-xl">
      <Sheet.Header className="gap-2 border-b border-border/60 bg-background/45 p-5 pr-12 backdrop-blur-xl">
        <div className="flex items-start justify-between gap-2">
          <Sheet.Title className="text-xl leading-tight tracking-tight">{title}</Sheet.Title>
          {canEnterEditMode && !editing && (
            <Button
              variant="ghost"
              size="icon"
              className="-mt-1 size-8 shrink-0"
              aria-label="Edit"
              onClick={startEditing}
            >
              <Pencil className="size-4" />
            </Button>
          )}
        </div>
        {/* Always render a description so Radix has an accessible description to
            point `aria-describedby` at (otherwise it logs a console warning). */}
        {subtitle != null && subtitle !== '' ? (
          <Sheet.Description className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {subtitle}
          </Sheet.Description>
        ) : (
          <Sheet.Description className="sr-only">{`Details for ${title}`}</Sheet.Description>
        )}
      </Sheet.Header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        {media}

        {children}

        {editFields && editFields.length > 0 && (
          <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-card/45 p-4 shadow-sm backdrop-blur">
            {editFields.map((field) => (
              <div key={field.key} className="flex flex-col gap-2">
                <Label htmlFor={`field-${field.key}`}>{field.label}</Label>
                {editing ? (
                  field.multiline ? (
                    <Textarea
                      id={`field-${field.key}`}
                      value={values[field.key] ?? ''}
                      placeholder={field.placeholder}
                      className="min-h-[100px]"
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                      }
                    />
                  ) : (
                    <Input
                      id={`field-${field.key}`}
                      type={field.inputType ?? 'text'}
                      value={values[field.key] ?? ''}
                      placeholder={field.placeholder}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                      }
                    />
                  )
                ) : field.value ? (
                  <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{field.value}</p>
                ) : (
                  <p className="text-sm italic text-muted-foreground">—</p>
                )}
              </div>
            ))}
          </section>
        )}

        {detailSections}

        {visibleMeta.length > 0 && (
          <Card className="gap-0 border-border/60 bg-card/45 p-0 shadow-sm backdrop-blur">
            <Card.Header className="p-4 pb-2">
              <Card.Title className="text-sm">Details</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-col divide-y divide-border/50 p-4 pt-0">
              {visibleMeta.map((item) => (
                <div
                  key={item.label}
                  className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
                    {item.label}
                  </span>
                  <span className="min-w-0 break-words text-sm">{item.value}</span>
                </div>
              ))}
            </Card.Content>
          </Card>
        )}

        {taggable && ref.globalId && (currentTags.length > 0 || editing) && (
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card/45 p-4 shadow-sm backdrop-blur">
            <Label>Tags</Label>
            <TagInput
              key={ref.globalId}
              tags={currentTags}
              readOnly={!editing}
              onTagAdded={async (label) => {
                try {
                  await tagEntities([ref.globalId!], [label]);

                  return true;
                } catch {
                  toast.error(`Couldn't add tag “${label}”.`);

                  return false;
                }
              }}
              onTagRemoved={async (label) => {
                try {
                  await untagEntities([ref.globalId!], [label]);

                  return true;
                } catch {
                  // Returning false tells the TagInput to roll back its optimistic removal.
                  toast.error(`Couldn't remove tag “${label}”.`);

                  return false;
                }
              }}
            />
          </div>
        )}

        {ref.rawId && <EntityRelationshipCards key={ref.rawId} entityId={ref.rawId} />}

        {rawData != null && <RawDataDetails data={rawData} />}

        {detailPath && (
          <Link
            to={detailPath}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Open full page <span aria-hidden>↗</span>
          </Link>
        )}
      </div>

      {editing && (
        <Sheet.Footer className="gap-2 border-t border-border/60 bg-background/55 backdrop-blur-xl">
          {saveError && (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          )}
          <div className="flex flex-row justify-end gap-2">
            {/* Tags-only mode persists each tag immediately, so its footer just
                exits edit mode ("Done") with no separate Save step. */}
            <Button variant="outline" onClick={handleCancel} disabled={saving}>
              {canEdit ? 'Cancel' : 'Done'}
            </Button>
            {canEdit && (
              <Button onClick={handleSave} disabled={saving} className={cn(saving && 'opacity-80')}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {saving ? 'Saving…' : 'Save'}
              </Button>
            )}
          </div>
        </Sheet.Footer>
      )}
    </Sheet.Content>
  );
}
