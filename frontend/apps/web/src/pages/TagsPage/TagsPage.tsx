import { useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, usePageTitle } from '@ci/common';
import { IconButton, Input } from '@ci/shadcn';
import { Pencil, Trash } from '@ci/shadcn/icons';
import { Link, useSearchParams } from 'react-router-dom';

import { ErrorState } from '@/components/ErrorState';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { PullToRefresh } from '@/components/PullToRefresh';
import { Tag } from '@/components/Tag';
import { gql } from '@/graphql';

import { DeleteTagModal } from './DeleteTagModal';
import { RenameTagModal } from './RenameTagModal';
import { type TagListItem } from './tagList';

// Deliberately not named `GetTags` — MemoryEntityTypeNav already owns that
// operation name, and this one asks for `entityCount` on top.
const GET_TAGS_WITH_USAGE = gql(`
  query GetTagsWithUsage {
    tags {
      edges {
        node {
          id
          label
          description
          entityCount
        }
      }
    }
  }
`);

export { GET_TAGS_WITH_USAGE };

export function TagsPage() {
  usePageTitle('Tags - Companion Intelligence');

  // Search text lives in the URL (`?q=`), like every other Memory hub page,
  // so it survives navigation/reload instead of resetting on remount. The
  // query itself takes no search variable — this is a pure client-side
  // filter over the already-fetched list.
  const [searchParams, setSearchParams] = useSearchParams();
  const searchQuery = searchParams.get('q') ?? '';
  const setSearchQuery = (value: string) => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);

      if (value) {
        next.set('q', value);
      } else {
        next.delete('q');
      }

      return next;
    });
  };

  const [tagToEdit, setTagToEdit] = useState<TagListItem | null>(null);
  const [tagToDelete, setTagToDelete] = useState<TagListItem | null>(null);
  const { data, loading, error, refetch } = useQuery(GET_TAGS_WITH_USAGE);

  const sortedTags = useMemo(() => {
    const nodes = data?.tags?.edges.map((edge) => edge.node) ?? [];

    return [...nodes].sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  }, [data]);

  const filteredTags = useMemo(
    () => sortedTags.filter((tag) => tag.label.toLowerCase().includes(searchQuery.toLowerCase())),
    [searchQuery, sortedTags],
  );

  return (
    <>
      <PullToRefresh onRefresh={refetch}>
        <PageContent className="gap-4 p-0">
          <MemoryHubShell>
            <div className="flex flex-col gap-4 px-2 pb-3 sm:px-4 sm:pb-4">
              <Input
                placeholder="Filter tags..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />

              {loading ? (
                <p className="text-sm text-muted-foreground">Loading tags…</p>
              ) : error ? (
                <ErrorState
                  title="Could not load tags"
                  description="Your tags are still here — this device could not reach them just now."
                  onRetry={() => void refetch()}
                />
              ) : sortedTags.length === 0 ? (
                <EmptyState message="No tags yet. Tags appear as you organize events and other memory." />
              ) : filteredTags.length === 0 ? (
                <EmptyState message="No tags match your filter." />
              ) : (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {filteredTags.map((tag) => (
                    <li key={tag.id} className="flex items-center gap-3 px-3 py-2">
                      <Link
                        to={`/memory?tags=${encodeURIComponent(tag.label)}`}
                        className="flex min-w-0 flex-1 items-center gap-3"
                      >
                        <Tag text={tag.label} className="cursor-pointer" />
                        {tag.description ? (
                          <span className="truncate text-sm text-muted-foreground">{tag.description}</span>
                        ) : null}
                      </Link>

                      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                        {tag.entityCount === 1 ? '1 item' : `${tag.entityCount} items`}
                      </span>

                      <IconButton
                        variant="ghost"
                        label={`Edit ${tag.label}`}
                        onClick={() => setTagToEdit(tag)}
                      >
                        <Pencil className="h-4 w-4" />
                      </IconButton>

                      <IconButton
                        variant="ghost"
                        label={`Delete ${tag.label}`}
                        onClick={() => setTagToDelete(tag)}
                      >
                        <Trash className="h-4 w-4" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </MemoryHubShell>
        </PageContent>
      </PullToRefresh>

      {tagToEdit ? (
        <RenameTagModal
          tag={tagToEdit}
          tags={sortedTags}
          onClose={() => setTagToEdit(null)}
          // A merge deletes the edited tag and moves its entities, so the list
          // and every count on it can change — refetch rather than patch.
          onRenamed={() => void refetch()}
        />
      ) : null}

      {tagToDelete ? (
        <DeleteTagModal
          tag={tagToDelete}
          onClose={() => setTagToDelete(null)}
          onDeleted={() => void refetch()}
        />
      ) : null}
    </>
  );
}
