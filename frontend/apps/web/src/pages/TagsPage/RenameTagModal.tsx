import { useMemo, useState } from 'react';

import { useMutation } from '@apollo/client/react';
import { Button, Dialog, Input, Label, Textarea } from '@ci/shadcn';

import { gql } from '@/graphql';

import { evictTag, normalizeTagLabel, type TagListItem } from './tagList';

interface Props {
  tag: TagListItem;
  /** Every tag the user has, so a rename onto an existing label can be flagged before it happens. */
  tags: TagListItem[];
  onClose: () => void;
  onRenamed: () => void;
}

const UPDATE_TAG = gql(`
  mutation UpdateTag($input: UpdateTagInput!) {
    updateTag(input: $input) {
      success
      merged
      movedEntityCount
      updatedSavedSearchCount
      tag {
        id
        label
        description
        entityCount
      }
    }
  }
`);

export function RenameTagModal({ tag, tags, onClose, onRenamed }: Props) {
  const [label, setLabel] = useState(tag.label);
  const [description, setDescription] = useState(tag.description ?? '');
  const [error, setError] = useState<string | null>(null);

  const [updateTag, { loading: saving }] = useMutation(UPDATE_TAG, {
    update(cache, { data }) {
      // A plain rename lands on the normalized tag by id. A merge instead
      // deletes the tag being edited, so it has to be evicted by hand.
      if (data?.updateTag?.merged) {
        evictTag(cache, tag.id);
      }
    },
  });

  const nextLabel = normalizeTagLabel(label);
  const renaming = nextLabel !== tag.label;

  // The server merges rather than failing when the new label is taken; say so
  // up front, because a merge is not undoable and moves other tags' entities.
  const mergeTarget = useMemo(
    () => (renaming ? (tags.find((other) => other.label === nextLabel) ?? null) : null),
    [nextLabel, renaming, tags],
  );

  const handleSave = async () => {
    setError(null);

    if (nextLabel.length === 0) {
      setError('A tag needs a label.');

      return;
    }

    try {
      const { data } = await updateTag({
        variables: {
          input: {
            id: tag.id,
            label: nextLabel,
            description: description.trim() === '' ? null : description.trim(),
          },
        },
      });

      if (!data?.updateTag.success) {
        setError('Could not update this tag. Please try again.');

        return;
      }

      onRenamed();
      onClose();
    } catch {
      // Leave the dialog open on failure — closing it would read as a save.
      setError('Could not update this tag. Please try again.');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Edit tag</Dialog.Title>
          <Dialog.Description>
            Renaming a tag updates it everywhere it is used, including saved searches that filter on it.
          </Dialog.Description>
        </Dialog.Header>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="tag-label">Label</Label>
            <Input
              id="tag-label"
              value={label}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />
            {renaming && nextLabel !== label.trim() ? (
              <p className="text-xs text-muted-foreground">
                Tags are lower case — this saves as “{nextLabel}”.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tag-description">Description</Label>
            <Textarea
              id="tag-description"
              value={description}
              placeholder="Optional"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {mergeTarget ? (
            <p className="text-sm text-destructive">
              You already have a “{mergeTarget.label}” tag. Saving will merge the two: the{' '}
              {tag.entityCount === 1 ? '1 item' : `${tag.entityCount} items`} tagged “{tag.label}” will move
              onto it and “{tag.label}” will be gone. This cannot be undone.
            </p>
          ) : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Dialog.Footer>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={mergeTarget ? 'destructive' : 'default'}
            onClick={handleSave}
            disabled={saving || nextLabel.length === 0}
          >
            {saving ? 'Saving…' : mergeTarget ? 'Merge tags' : 'Save'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}
