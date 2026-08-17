import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, LoadingPage, usePageTitle } from '@ci/common';
import { AlertDialog, Avatar, Badge, Button, Card, Input } from '@ci/shadcn';
import { Merge } from '@ci/shadcn/icons';
import { Link, useNavigate } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { gql } from '@/graphql';
import type { GetPeopleQuery, GetPersonDuplicatesQuery } from '@/graphql/graphql';

// Matches MemoryPage's PAGE_SIZE. Keeping it small also keeps the batch handed
// to PersonInteractionStatsLoader small — that resolver aggregates over the
// `ci.communications` hypertable, and its cost scales with the id-array length.
export const PAGE_SIZE = 30;

const GET_PEOPLE = gql(`
  query GetPeople($query: String, $first: Int, $after: String) {
    people(query: $query, first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          name
          description
          firstName
          lastName
          avatarUrl
          birthDate
          isSelf
          identifiers {
            kind
            value
            label
          }
          interactionStats {
            eventCount
            communicationCount
            lastInteractionAt
          }
        }
      }
    }
  }
`);

const GET_PERSON_DUPLICATES = gql(`
  query GetPersonDuplicates {
    personDuplicates {
      reason
      value
      people {
        id
        name
        description
        avatarUrl
        isSelf
      }
    }
  }
`);

const MERGE_PEOPLE = gql(`
  mutation MergePeople($input: MergePeopleInput!) {
    mergePeople(input: $input) {
      success
      person {
        id
        name
      }
    }
  }
`);

const REJECT_PERSON_DUPLICATES = gql(`
  mutation RejectPersonDuplicates($personIds: [ID!]!) {
    rejectPersonDuplicates(personIds: $personIds)
  }
`);

type PersonNode = GetPeopleQuery['people']['edges'][number]['node'];
type DuplicateGroup = GetPersonDuplicatesQuery['personDuplicates'][number];

function resolveAvatarUrl(avatarUrl: string | null | undefined): string | undefined {
  if (!avatarUrl) {
    return undefined;
  }

  return /^https?:\/\//.test(avatarUrl) ? avatarUrl : `/static${avatarUrl}`;
}

function initialsFor(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) {
    return '?';
  }

  const parts = trimmed.split(/\s+/);

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function formatLastInteraction(value: string | Date | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleDateString();
}

function PersonRow({ person, onOpen }: { person: PersonNode; onOpen: () => void }) {
  const email = person.identifiers.find((identifier) => identifier.kind === 'email');
  const phone = person.identifiers.find((identifier) => identifier.kind === 'phone');
  const lastSeen = formatLastInteraction(person.interactionStats.lastInteractionAt);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-md border bg-card p-3 text-left transition hover:bg-accent"
    >
      <Avatar className="h-10 w-10 shrink-0">
        <Avatar.Image src={resolveAvatarUrl(person.avatarUrl)} alt={person.name ?? ''} />
        <Avatar.Fallback>{initialsFor(person.name)}</Avatar.Fallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{person.name || 'Unnamed'}</span>
          {person.isSelf && <Badge variant="secondary">You</Badge>}
        </div>

        <div className="truncate text-sm text-muted-foreground">
          {[email?.value, phone?.value, person.description].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>

      <div className="hidden shrink-0 text-right text-sm text-muted-foreground sm:block">
        <div>
          {person.interactionStats.eventCount} events · {person.interactionStats.communicationCount} messages
        </div>
        {lastSeen && <div>Last seen {lastSeen}</div>}
      </div>
    </button>
  );
}

function DuplicateGroupCard({
  group,
  onMerged,
}: {
  group: DuplicateGroup;
  onMerged: () => Promise<unknown>;
}) {
  const [mergePeople, { loading }] = useMutation(MERGE_PEOPLE);
  const [rejectDuplicates, { loading: rejecting }] = useMutation(REJECT_PERSON_DUPLICATES);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // The self person (if present) is always the preferred merge target — the
  // backend refuses to merge it away, so when the group contains "You" the
  // other members must not be offered as targets.
  const orderedPeople = useMemo(
    () => [...group.people].sort((a, b) => Number(b.isSelf) - Number(a.isSelf)),
    [group.people],
  );
  const hasSelf = orderedPeople.some((person) => person.isSelf);

  const merge = async (targetId: string) => {
    const sourceIds = group.people.map((person) => person.id).filter((id) => id !== targetId);

    try {
      await mergePeople({ variables: { input: { targetId, sourceIds } } });
      setPendingTargetId(null);
      setMergeError(null);
      await onMerged();
    } catch (error) {
      // Keep the dialog open and show what went wrong instead of silently
      // closing on failure.
      setMergeError(error instanceof Error ? error.message : 'The merge failed. Please try again.');
    }
  };

  // Saying "not the same" has to STICK. Duplicate groups are recomputed from
  // identifiers on every load, so without recording the rejection this exact
  // group would be proposed again immediately.
  const reject = async () => {
    try {
      await rejectDuplicates({ variables: { personIds: group.people.map((person) => person.id) } });
      setMergeError(null);
      await onMerged();
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Could not record that. Please try again.');
    }
  };

  const pendingTarget = orderedPeople.find((person) => person.id === pendingTargetId);

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Merge className="h-4 w-4" />
        <span>
          Same {group.reason === 'name' ? 'name' : group.reason}:{' '}
          <span className="font-medium text-foreground">{group.value}</span>
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {orderedPeople.map((person) => (
          <div key={person.id} className="flex items-center gap-3">
            <Avatar className="h-8 w-8 shrink-0">
              <Avatar.Image src={resolveAvatarUrl(person.avatarUrl)} alt={person.name ?? ''} />
              <Avatar.Fallback>{initialsFor(person.name)}</Avatar.Fallback>
            </Avatar>

            <div className="min-w-0 flex-1">
              <Link
                to={`/people/${GlobalUID.parse('person', person.id)}`}
                className="truncate font-medium hover:underline"
              >
                {person.name || 'Unnamed'}
              </Link>
              {person.isSelf && (
                <Badge variant="secondary" className="ml-2">
                  You
                </Badge>
              )}
              {person.description && (
                <div className="truncate text-sm text-muted-foreground">{person.description}</div>
              )}
            </div>

            {(!hasSelf || person.isSelf) && (
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => {
                  setMergeError(null);
                  setPendingTargetId(person.id);
                }}
              >
                Keep this one
              </Button>
            )}
          </div>
        ))}
      </div>

      {/* The other half of the decision. Without it the only way to clear a
          wrong suggestion is to merge people who are not the same, and the
          group returns on every load. */}
      <div className="mt-3 flex items-center justify-end gap-3 border-t pt-2">
        {mergeError && !pendingTargetId && <span className="text-sm text-destructive">{mergeError}</span>}
        <Button size="sm" variant="ghost" disabled={loading || rejecting} onClick={() => void reject()}>
          {rejecting ? 'Saving…' : 'Not the same person'}
        </Button>
      </div>

      <AlertDialog
        open={pendingTargetId != null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTargetId(null);
          }
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Merge people?</AlertDialog.Title>
            <AlertDialog.Description>
              {`The other ${group.people.length - 1 === 1 ? 'person' : `${group.people.length - 1} people`} in this group will be merged into "${pendingTarget?.name || 'Unnamed'}". Their events, messages and contact methods move over; this cannot be undone from the UI.`}
            </AlertDialog.Description>
          </AlertDialog.Header>
          {mergeError && <div className="text-sm text-destructive">{mergeError}</div>}
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={loading}>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              disabled={loading || pendingTargetId == null}
              onClick={(e) => {
                // Radix auto-closes on Action click; keep the dialog open so a
                // failure (or the in-flight state) stays visible.
                e.preventDefault();
                if (pendingTargetId != null) {
                  void merge(pendingTargetId);
                }
              }}
            >
              {loading ? 'Merging…' : 'Merge'}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </div>
  );
}

export function PeoplePage() {
  usePageTitle('People & communications - Companion Intelligence');

  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  const { data, previousData, loading, error, refetch, fetchMore } = useQuery(GET_PEOPLE, {
    variables: { query: searchQuery.trim() === '' ? null : searchQuery.trim(), first: PAGE_SIZE },
    notifyOnNetworkStatusChange: true,
  });
  const {
    data: duplicatesData,
    error: duplicatesError,
    refetch: refetchDuplicates,
  } = useQuery(GET_PERSON_DUPLICATES);

  // Keep the previous result on screen while a new query variable is in
  // flight — swapping to a full-page loader would unmount the search input and
  // drop focus on the first keystroke of every new query.
  const view = data ?? previousData;
  const people = useMemo(() => {
    const nodes = (view?.people.edges ?? []).map((edge) => edge.node);

    return [...nodes].sort((a, b) => {
      const aTime = a.interactionStats?.lastInteractionAt
        ? new Date(a.interactionStats.lastInteractionAt).getTime()
        : 0;
      const bTime = b.interactionStats?.lastInteractionAt
        ? new Date(b.interactionStats.lastInteractionAt).getTime()
        : 0;

      return bTime - aTime;
    });
  }, [view]);
  const duplicateGroups = duplicatesData?.personDuplicates ?? [];

  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const pageInfo = view?.people.pageInfo;
  const hasNextPage = pageInfo?.hasNextPage ?? false;
  const totalCount = view?.people.totalCount ?? 0;

  // Append the next server page (cursor-based) onto the accumulated results.
  const loadMore = useCallback(() => {
    if (!hasNextPage || loadingMore || loadMoreError != null || !pageInfo?.endCursor) {
      return;
    }

    setLoadingMore(true);

    fetchMore({
      variables: { after: pageInfo.endCursor },
      updateQuery: (prev, { fetchMoreResult }) => {
        if (!fetchMoreResult?.people) {
          return prev;
        }

        const prevEdges = prev.people?.edges ?? [];
        const seen = new Set(prevEdges.map((edge) => edge.cursor));
        const nextEdges = fetchMoreResult.people.edges.filter((edge) => !seen.has(edge.cursor));

        return {
          people: {
            ...fetchMoreResult.people,
            edges: [...prevEdges, ...nextEdges],
          },
        };
      },
    })
      .catch((cause: unknown) => {
        // fetchMore rejects on network/GraphQL errors, and an unhandled rejection
        // is only half the problem: the sentinel is still on screen, so clearing
        // `loadingMore` would rebuild the observer, which re-fires immediately on
        // observe() and spins a request loop (measured at ~220 requests in 300ms
        // against a persistently failing page). Latch the error instead — it
        // unmounts the sentinel and gates `loadMore` until the user retries.
        setLoadMoreError(cause instanceof Error ? cause.message : 'Something went wrong.');
      })
      .finally(() => setLoadingMore(false));
  }, [fetchMore, hasNextPage, loadingMore, loadMoreError, pageInfo?.endCursor]);

  // Fetch the next server page when the sentinel scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !hasNextPage) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { root: scrollRef.current, rootMargin: '400px' },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasNextPage, loadMore]);

  const onMerged = async () => Promise.all([refetch(), refetchDuplicates()]);

  let content: ReactNode | null = null;

  if (loading && view == null) {
    content = <LoadingPage />;
  } else if (error && view == null) {
    content = <EmptyState message={`Couldn't load people: ${error.message}`} />;
  } else {
    content = (
      <PageContent ref={scrollRef} className="gap-4 p-0">
        <MemoryHubShell>
          <div className="flex flex-col gap-4 px-4 pb-4">
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search people and communications..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  // New query, new cursor space — a stale failure must not gate it.
                  setLoadMoreError(null);
                }}
                className="max-w-xl flex-1"
              />
              <div className="text-sm text-muted-foreground">{totalCount} people</div>
            </div>

            {duplicatesError && (
              <div className="text-sm text-muted-foreground">
                Duplicate suggestions are unavailable right now ({duplicatesError.message}).
              </div>
            )}

            {duplicateGroups.length > 0 && (
              <Card>
                <Card.Header>
                  <Card.Title className="flex items-center gap-2 text-base">
                    <Merge className="h-4 w-4" />
                    Possible duplicates
                  </Card.Title>
                  <Card.Description>
                    These people share an email, phone number or name. Review and merge the ones that are the
                    same person.
                  </Card.Description>
                </Card.Header>
                <Card.Content className="flex flex-col gap-3">
                  {duplicateGroups.map((group) => (
                    <DuplicateGroupCard
                      key={`${group.reason}:${group.value}`}
                      group={group}
                      onMerged={onMerged}
                    />
                  ))}
                </Card.Content>
              </Card>
            )}

            {people.length === 0 ? (
              <EmptyState message="No people found" />
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {people.map((person) => (
                    <PersonRow
                      key={person.id}
                      person={person}
                      onOpen={() => navigate(`/people/${GlobalUID.parse('person', person.id)}`)}
                    />
                  ))}
                </div>

                {hasNextPage && loadMoreError == null && <div ref={sentinelRef} className="h-8" />}

                {loadMoreError != null && (
                  <div className="flex flex-col items-center gap-2 py-3">
                    <div className="text-sm text-muted-foreground">
                      Couldn&apos;t load more people: {loadMoreError}
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setLoadMoreError(null)}>
                      Try again
                    </Button>
                  </div>
                )}

                <div className="py-3 text-center text-xs text-muted-foreground">
                  {people.length} of {totalCount} loaded
                  {loadingMore ? ' · loading…' : hasNextPage ? '' : ' · end'}
                </div>
              </>
            )}
          </div>
        </MemoryHubShell>
      </PageContent>
    );
  }

  return <>{content}</>;
}
