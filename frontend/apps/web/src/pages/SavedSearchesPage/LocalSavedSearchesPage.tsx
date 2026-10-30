import { type ReactNode, useCallback, useState } from 'react';

import { EmptyState, usePageTitle, useOptionalConnectionMode } from '@ci/common';
import { AlertDialog, Button, Collapsible, Dialog, Input, Label, Textarea, useToast } from '@ci/shadcn';
import { ChevronRight, Plus, Search } from '@ci/shadcn/icons';
import { Link, useSearchParams } from 'react-router-dom';

import {
  deleteLocalSavedSearch,
  renameLocalSavedSearch,
  toResolvedSavedSearch,
  useLocalSavedSearches,
  type LocalSavedSearch,
} from '@/api/powersync/localSavedSearches';
import { getReplicaDatabase } from '@/api/powersync/session';
import { ErrorState } from '@/components/ErrorState';
import { SavedSearchIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import type { FragmentType } from '@/graphql/fragment-masking';

import { SavedSearch, type SavedSearchGridItemFragment } from './SavedSearch';
import { ShareSavedSearchModal } from './ShareSavedSearchModal';

/**
 * The row component reads the GraphQL fragment's fields; the local row carries the same
 * ones under the same names (`toResolvedSavedSearch`), so one adapter stands in for the
 * mask. Fragment masking is a type-level device: at runtime `useFragment` returns the
 * object it is given.
 */
function asFragment(search: LocalSavedSearch): FragmentType<typeof SavedSearchGridItemFragment> {
  return toResolvedSavedSearch(search) as unknown as FragmentType<typeof SavedSearchGridItemFragment>;
}

/**
 * The saved searches page on a phone with a replica: the synced `saved_searches` table,
 * online or off, the way the notes pages work. Listing, filtering, opening, renaming and
 * deleting all happen against the phone's table and PowerSync carries the changes up
 * when the Memory server answers again. Two things stay the appliance's: editing a
 * search's filters, which the explorer does (Edit opens the search there and Save
 * writes it back), and sharing, which needs the server to mint the link and is offered
 * only while it answers.
 */
export function LocalSavedSearchesPage() {
  usePageTitle('Saved Searches - Companion Memory');

  const { toast } = useToast();
  const connection = useOptionalConnectionMode();
  const online = connection == null || (connection.isResolved && connection.mode === 'connected');
  const [searchParams, setSearchParams] = useSearchParams();
  const searchText = searchParams.get('q') ?? '';
  const trimmedQuery = searchText.trim();

  const setSearchText = useCallback(
    (value: string) => {
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);

          if (value === '') {
            next.delete('q');
          } else {
            next.set('q', value);
          }

          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [starterOpen, setStarterOpen] = useState(false);
  const [toRename, setToRename] = useState<LocalSavedSearch | null>(null);
  const [toDelete, setToDelete] = useState<LocalSavedSearch | null>(null);
  const [toShare, setToShare] = useState<LocalSavedSearch | null>(null);

  const yours = useLocalSavedSearches({ query: trimmedQuery, isSeed: false });
  const starter = useLocalSavedSearches({ query: trimmedQuery, isSeed: true });

  const stop = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const rows = (searches: LocalSavedSearch[]) =>
    searches.map((search) => (
      <SavedSearch
        key={search.id}
        savedSearch={asFragment(search)}
        openSavedSearchEditModal={(event) => {
          stop(event);
          setToRename(search);
        }}
        openSavedSearchShareModal={(event) => {
          stop(event);

          if (online) {
            setToShare(search);
          } else {
            toast.error('Sharing needs the Memory server. Try again once it is reachable.');
          }
        }}
        openSavedSearchDeleteModal={(event) => {
          stop(event);
          setToDelete(search);
        }}
      />
    ));

  let yourContent: ReactNode;
  let yourContentIsOverlay = false;

  if (yours.error) {
    yourContent = (
      <ErrorState
        title="Couldn't read this phone's saved searches"
        description="The copy saved on this phone could not be read just now. Close the app fully and open it again if it keeps failing."
      />
    );
  } else if (yours.searches.length === 0) {
    yourContentIsOverlay = true;
    yourContent = trimmedQuery ? (
      <EmptyState message={`No saved searches match "${trimmedQuery}".`} />
    ) : (
      <EmptyState
        icon={<SavedSearchIcon size={48} colorized={false} />}
        message={
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <div>
              <div className="font-medium">You don't have any Saved Searches yet.</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Save a search you are running from Memory's advanced filters. It is kept on this phone and
                reaches your Memory server when it next answers.
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild>
                <Link to="/memory">
                  <Plus className="mr-2 h-4 w-4" />
                  New saved search
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/memory">
                  <Search className="mr-2 h-4 w-4" />
                  Search Memory
                </Link>
              </Button>
            </div>
          </div>
        }
      />
    );
  } else {
    yourContent = <div className="w-full border-t border-border/50">{rows(yours.searches)}</div>;
  }

  let starterContent: ReactNode = null;

  if (starterOpen) {
    starterContent =
      starter.searches.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground sm:px-3">
          {trimmedQuery ? `No starter searches match "${trimmedQuery}".` : 'No starter searches.'}
        </p>
      ) : (
        <div className="w-full border-t border-border/50">{rows(starter.searches)}</div>
      );
  }

  return (
    <>
      <PageContent className="gap-3">
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search your saved searches by name, description or tag..."
            className="w-full sm:max-w-sm"
          />
          <Button asChild className="shrink-0">
            <Link to="/memory">
              <Plus className="mr-2 h-4 w-4" />
              New saved search
            </Link>
          </Button>
        </div>

        {!yours.isLoading && !yours.error && (
          <div className="text-sm text-muted-foreground" data-testid="local-saved-searches-count">
            {yours.searches.length} saved {yours.searches.length === 1 ? 'search' : 'searches'}
          </div>
        )}

        {yourContentIsOverlay ? <div className="relative min-h-72 w-full">{yourContent}</div> : yourContent}

        <Collapsible open={starterOpen} onOpenChange={setStarterOpen} className="w-full pt-2">
          <Collapsible.Trigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={
                  starterOpen ? 'h-4 w-4 rotate-90 transition-transform' : 'h-4 w-4 transition-transform'
                }
              />
              Starter searches
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content>{starterContent}</Collapsible.Content>
        </Collapsible>
      </PageContent>

      {toRename && <RenameLocalSavedSearchDialog search={toRename} onClose={() => setToRename(null)} />}

      {toDelete && (
        <AlertDialog open onOpenChange={(open) => !open && setToDelete(null)}>
          <AlertDialog.Content>
            <AlertDialog.Header className="text-left">
              <AlertDialog.Title>Delete “{toDelete.name || 'Untitled saved search'}”?</AlertDialog.Title>
              <AlertDialog.Description>
                It is removed from this phone now and from your Memory server when it next answers. Nothing it
                found is deleted, only the saved filters.
              </AlertDialog.Description>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  const database = getReplicaDatabase();
                  const target = toDelete;

                  setToDelete(null);

                  if (!database) {
                    return;
                  }

                  void deleteLocalSavedSearch(database, target.id).catch((error: unknown) => {
                    console.warn('[memory] Could not delete the saved search on this phone', error);
                    toast.error('Could not delete the saved search');
                  });
                }}
              >
                Delete
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog>
      )}

      {toShare && (
        <ShareSavedSearchModal savedSearch={asFragment(toShare)} onClose={() => setToShare(null)} />
      )}
    </>
  );
}

/** Name and description only: the filters are edited in the explorer, where Save writes them back. */
function RenameLocalSavedSearchDialog({
  search,
  onClose,
}: {
  search: LocalSavedSearch;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(search.name ?? '');
  const [description, setDescription] = useState(search.description ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const database = getReplicaDatabase();
    const trimmed = name.trim();

    if (!database || !trimmed) {
      return;
    }

    setSaving(true);

    try {
      await renameLocalSavedSearch(database, {
        id: search.id,
        name: trimmed,
        description: description.trim() || null,
      });
      onClose();
    } catch (error) {
      console.warn('[memory] Could not rename the saved search on this phone', error);
      toast.error('Could not save the changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Edit saved search</Dialog.Title>
          <Dialog.Description>
            Its name and description. To change what it finds, open it in Memory, adjust the filters and use
            Save to update it.
          </Dialog.Description>
        </Dialog.Header>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="local-saved-search-name">Name</Label>
            <Input
              id="local-saved-search-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="local-saved-search-description">Description</Label>
            <Textarea
              id="local-saved-search-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <Dialog.Footer>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}
