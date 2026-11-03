import { useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, usePageTitle } from '@ci/common';
import { DropdownMenu, IconButton } from '@ci/shadcn';
import { Ellipsis, Pencil, Trash } from '@ci/shadcn/icons';
import { Link, useSearchParams } from 'react-router-dom';

import { useAnswersFromDevice } from '@/api/powersync/deviceFallback';
import { ErrorState } from '@/components/ErrorState';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { LoadingRegion, TagRowsSkeleton } from '@/components/MemoryHub/MemoryHubSkeletons';
import { PullToRefresh } from '@/components/PullToRefresh';
import { Tag } from '@/components/Tag';
import { gql } from '@/graphql';

import { DeleteTagModal } from './DeleteTagModal';
import { LocalTagsList } from './LocalTagsList';
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

/**
 * The tags page. While the Memory server does not answer and this phone holds a synced
 * replica, the list comes from the phone (LocalTagsList: the synced tags and their
 * counts, no editing); otherwise from the appliance. See api/powersync/deviceFallback.ts.
 */
export function TagsPage() {
  const offline = useAnswersFromDevice();

  return offline ? <LocalTagsList /> : <RemoteTagsPage />;
}

function RemoteTagsPage() {
  usePageTitle('Tags - Companion Memory');

  // Search text is the header search box's `?search=` — it edits this page's
  // query in place (see GlobalSearchBox / isLiveSearchPath), so the page has
  // no input of its own. The query itself takes no search variable — this is
  // a pure client-side filter over the already-fetched list.
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('search') ?? '';

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
        <PageContent className="gap-2 p-0 device:gap-4">
          <MemoryHubShell>
            <div className="flex flex-col gap-2 px-2 pb-3 device:gap-4 device:px-4 device:pb-4">
              {loading ? (
                <LoadingRegion label="Loading tags">
                  <TagRowsSkeleton />
                </LoadingRegion>
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
                    <li
                      key={tag.id}
                      data-testid="tag-row"
                      className="flex items-center gap-2 px-2 py-1.5 device:gap-3 device:px-3 device:py-2"
                    >
                      <Link
                        to={`/memory?tags=${encodeURIComponent(tag.label)}`}
                        className="flex min-w-0 flex-1 items-center gap-2 device:gap-3"
                      >
                        <Tag
                          text={tag.label}
                          className="min-w-0 max-w-full cursor-pointer [&>span]:truncate"
                        />
                        {tag.description ? (
                          <span className="hidden min-w-0 truncate text-sm text-muted-foreground device:block">
                            {tag.description}
                          </span>
                        ) : null}
                      </Link>

                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground device:text-sm">
                        {tag.entityCount === 1 ? '1 item' : `${tag.entityCount} items`}
                      </span>

                      <DropdownMenu modal>
                        <DropdownMenu.Trigger asChild>
                          <IconButton
                            variant="ghost"
                            label={`Actions for ${tag.label}`}
                            className="size-8 device:hidden"
                          >
                            <Ellipsis className="h-4 w-4" />
                          </IconButton>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content align="end">
                          <DropdownMenu.Item onSelect={() => setTagToEdit(tag)}>
                            <Pencil />
                            Edit
                          </DropdownMenu.Item>
                          <DropdownMenu.Item variant="destructive" onSelect={() => setTagToDelete(tag)}>
                            <Trash />
                            Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu>

                      <IconButton
                        variant="ghost"
                        label={`Edit ${tag.label}`}
                        className="hidden device:inline-flex"
                        onClick={() => setTagToEdit(tag)}
                      >
                        <Pencil className="h-4 w-4" />
                      </IconButton>

                      <IconButton
                        variant="ghost"
                        label={`Delete ${tag.label}`}
                        className="hidden device:inline-flex"
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
