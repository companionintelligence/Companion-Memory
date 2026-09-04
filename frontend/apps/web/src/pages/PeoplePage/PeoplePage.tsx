import { type ReactNode, useCallback, useMemo } from 'react';

import { useApolloClient, useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, LoadingPage, usePageTitle } from '@ci/common';
import { Badge, Button, Card } from '@ci/shadcn';
import { Merge } from '@ci/shadcn/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ChatAbout } from '@/components/ChatWithAgent';
import { ErrorState } from '@/components/ErrorState';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { PersonAvatar } from '@/components/PersonAvatar';
import { PullToRefresh } from '@/components/PullToRefresh';
import { gql } from '@/graphql';
import type { GetPeopleQuery } from '@/graphql/graphql';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';
import { namedChatContext } from '@/lib/agentChat';

import {
  groupMergeCandidates,
  MergeCandidateCard,
  MergeClusterCard,
  type MergeOutcome,
} from './PeopleMergeCards';

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
            rawValue
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

// The duplicate-detection pipeline's queue: scored pairs with evidence.
// Same-email / E.164-phone pairs are folded automatically when this query
// runs; name overlap stays here for a one-click merge (no extra confirm).
const GET_MERGE_CANDIDATES = gql(`
  query GetMergeCandidates($first: Int, $after: String) {
    mergeCandidates(first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          score
          status
          detectedBy
          createdAt
          evidence {
            kind
            value
            score
          }
          people {
            id
            name
            description
            avatarUrl
            isSelf
            identifiers {
              kind
              value
              rawValue
              label
              source
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
  }
`);

/**
 * Re-read the ONE person a merge kept. Merging moves events, messages and
 * identifiers onto the target, so its row is stale afterwards — but re-running
 * GET_PEOPLE to refresh it would replay that hook's original variables
 * (`first: PAGE_SIZE`, no cursor) and throw away every page the user scrolled
 * in. This writes the same normalized PersonType the list edge already points
 * at, so the row updates in place and the accumulated list survives.
 */
const GET_MERGED_PERSON = gql(`
  query GetMergedPerson($id: ID!) {
    person(id: $id) {
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
        rawValue
        label
      }
      interactionStats {
        eventCount
        communicationCount
        lastInteractionAt
      }
    }
  }
`);

type PersonNode = GetPeopleQuery['people']['edges'][number]['node'];

/** Candidates per page — "load more"-able. */
export const CANDIDATE_PAGE_SIZE = 20;

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
  // Prefer the raw form: `value` is the matching key (a phone normalizes to bare
  // digits), which reads as a mangled number in a contact list.
  const emailText = email?.rawValue?.trim() || email?.value;
  const phoneText = phone?.rawValue?.trim() || phone?.value;
  const lastSeen = formatLastInteraction(person.interactionStats.lastInteractionAt);

  return (
    <ChatAbout
      context={namedChatContext({
        title: person.name,
        body: person.description,
        sourceKind: 'PersonType',
        sourceId: person.id,
      })}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-md border bg-card p-3 text-left transition hover:bg-accent"
      >
        {/* size="md" is 40px — the exact h-10 w-10 this rendered before
          PersonAvatar existed. */}
        <PersonAvatar name={person.name} avatarUrl={person.avatarUrl} size="md" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{person.name || 'Unnamed'}</span>
            {person.isSelf && <Badge variant="secondary">You</Badge>}
          </div>

          <div className="truncate text-sm text-muted-foreground">
            {[emailText, phoneText, person.description].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>

        <div className="hidden shrink-0 text-right text-sm text-muted-foreground sm:block">
          <div>
            {person.interactionStats.eventCount} events · {person.interactionStats.communicationCount}{' '}
            messages
          </div>
          {lastSeen && <div>Last seen {lastSeen}</div>}
        </div>
      </button>
    </ChatAbout>
  );
}

export function PeoplePage() {
  usePageTitle('People & communications - Companion Intelligence');

  const navigate = useNavigate();
  // The header search box's `?search=`: it edits this page's query in place
  // (see GlobalSearchBox / isLiveSearchPath), so the page has no input of its
  // own. In the URL, it survives navigating away and back and is deep-linkable.
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('search') ?? '';

  const client = useApolloClient();

  // Same object identity the cache entry is keyed on, so the post-merge patch
  // below targets exactly the entry fetchMore has been appending to.
  const peopleVariables = useMemo(
    () => ({ query: searchQuery.trim() === '' ? null : searchQuery.trim(), first: PAGE_SIZE }),
    [searchQuery],
  );

  const { data, previousData, loading, error, fetchMore, refetch } = useQuery(GET_PEOPLE, {
    variables: peopleVariables,
    notifyOnNetworkStatusChange: true,
  });

  // The scored queue the duplicate-detection pipeline has been filling.
  const {
    data: candidatesData,
    error: candidatesError,
    refetch: refetchCandidates,
    fetchMore: fetchMoreCandidates,
  } = useQuery(GET_MERGE_CANDIDATES, {
    variables: { first: CANDIDATE_PAGE_SIZE },
    notifyOnNetworkStatusChange: true,
  });

  // Keep the previous result on screen while a new query variable is in
  // flight — swapping to a full-page loader would unmount the search input and
  // drop focus on the first keystroke of every new query.
  const view = data ?? previousData;
  // Trust PersonService.findAll's order (plausible-name first, then name, then
  // recency — see PERSON_NAME_LOOKS_IMPLAUSIBLE_SQL) rather than re-sorting here.
  // A client-side sort keyed on interaction recency would fight that: the exact
  // rows the server demotes (bare digit-strings, call-log-heading leftovers) are
  // typically call-log stubs, so they carry a *recent*
  // interactionStats.lastInteractionAt, while a freshly-imported real contact
  // may have none at all — a recency sort would put the garbage name right back
  // on top of the list, reintroducing the bug the backend ordering fixed.
  const people = useMemo(() => (view?.people.edges ?? []).map((edge) => edge.node), [view]);
  const mergeCandidates = useMemo(
    () => (candidatesData?.mergeCandidates.edges ?? []).map((edge) => edge.node),
    [candidatesData],
  );
  const mergeGroups = useMemo(() => groupMergeCandidates(mergeCandidates), [mergeCandidates]);
  const candidatesPageInfo = candidatesData?.mergeCandidates.pageInfo;

  const loadMoreCandidates = () =>
    void fetchMoreCandidates({
      variables: { after: candidatesPageInfo?.endCursor },
      updateQuery: (prev, { fetchMoreResult }) => {
        if (!fetchMoreResult?.mergeCandidates) {
          return prev;
        }

        const prevEdges = prev.mergeCandidates?.edges ?? [];
        const seen = new Set(prevEdges.map((edge) => edge.cursor));

        return {
          mergeCandidates: {
            ...fetchMoreResult.mergeCandidates,
            edges: [
              ...prevEdges,
              ...fetchMoreResult.mergeCandidates.edges.filter((edge) => !seen.has(edge.cursor)),
            ],
          },
        };
      },
    });

  // Append the next server page (cursor-based) onto the accumulated results.
  const fetchNextPage = useCallback(
    (after: string) =>
      fetchMore({
        variables: { after },
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
      }),
    [fetchMore],
  );

  const pagination = useInfiniteConnection({
    connection: view?.people,
    loadedCount: people.length,
    fetchNextPage,
  });

  const refreshPeople = useCallback(async () => {
    pagination.reset();
    await Promise.all([refetch(), refetchCandidates()]);
  }, [pagination, refetch, refetchCandidates]);

  // Patch the accumulated list rather than refetch()ing it. refetch() replays
  // the hook's ORIGINAL variables (first: PAGE_SIZE, no cursor) and overwrites
  // the cache entry fetchMore has been appending to, so on a 21k-person list
  // every merge threw the user back to row 30 — on the one page whose whole
  // purpose is working a long duplicate queue.
  const onMerged = useCallback(
    async ({ removedIds, keptId }: MergeOutcome) => {
      const removed = new Set(removedIds);

      if (removed.size > 0) {
        client.cache.updateQuery({ query: GET_PEOPLE, variables: peopleVariables }, (prev) => {
          if (!prev?.people) {
            return prev;
          }

          const edges = prev.people.edges.filter((edge) => !removed.has(edge.node.id));
          const dropped = prev.people.edges.length - edges.length;

          if (dropped === 0) {
            return prev;
          }

          return {
            ...prev,
            people: {
              ...prev.people,
              edges,
              totalCount: Math.max(0, prev.people.totalCount - dropped),
            },
          };
        });
      }

      await Promise.all([
        keptId != null
          ? client.query({
              query: GET_MERGED_PERSON,
              variables: { id: keptId },
              fetchPolicy: 'network-only',
            })
          : Promise.resolve(),
        refetchCandidates(),
      ]);

      // Only now that the scored candidates have been re-read (so nothing
      // still references them) is it safe to drop the merged-away people;
      // evicting first would leave that query pointing at missing objects
      // mid-render.
      if (removed.size > 0) {
        for (const id of removedIds) {
          client.cache.evict({ id: client.cache.identify({ __typename: 'PersonType', id }) });
        }

        client.cache.gc();
      }
    },
    [client, peopleVariables, refetchCandidates],
  );

  let content: ReactNode | null = null;

  if (loading && view == null) {
    content = <LoadingPage />;
  } else if (error && view == null) {
    content = (
      <ErrorState
        title="Could not load people"
        description="Your people are still here — this device could not reach them just now."
        onRetry={() => void refetch()}
      />
    );
  } else {
    content = (
      <PullToRefresh onRefresh={refreshPeople}>
        <PageContent ref={pagination.scrollRef} className="gap-4 p-0">
          <MemoryHubShell>
            <div className="flex flex-col gap-4 px-2 pb-3 sm:px-4 sm:pb-4">
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                <div className="text-sm text-muted-foreground">{pagination.totalCount} people</div>
              </div>

              {candidatesError && (
                <div className="text-sm text-muted-foreground">
                  Suggested merges are unavailable right now ({candidatesError.message}).
                </div>
              )}

              {mergeCandidates.length > 0 && (
                <Card>
                  <Card.Header>
                    <Card.Title className="flex items-center gap-2 text-base">
                      <Merge className="h-4 w-4" />
                      Suggested merges
                      <Badge variant="secondary">{candidatesData?.mergeCandidates.totalCount ?? 0}</Badge>
                    </Card.Title>
                    <Card.Description>
                      Name variants and uncertain matches. Same email or exact phone is folded automatically —
                      what remains is a question, with what differs on each side.
                    </Card.Description>
                  </Card.Header>
                  <Card.Content className="flex flex-col gap-3">
                    {mergeGroups.map((group) =>
                      group.type === 'cluster' ? (
                        <MergeClusterCard
                          key={`cluster:${group.anchor.id}:${group.token}`}
                          token={group.token}
                          anchor={group.anchor}
                          members={group.members}
                          onMerged={onMerged}
                        />
                      ) : (
                        <MergeCandidateCard
                          key={group.candidate.id}
                          candidate={group.candidate}
                          onMerged={onMerged}
                        />
                      ),
                    )}

                    {candidatesPageInfo?.hasNextPage && (
                      <div className="flex justify-center">
                        <Button variant="outline" size="sm" onClick={loadMoreCandidates}>
                          Load more suggestions
                        </Button>
                      </div>
                    )}

                    <div className="text-center text-xs text-muted-foreground">
                      {mergeCandidates.length} of {candidatesData?.mergeCandidates.totalCount ?? 0} shown
                    </div>
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

                  <InfiniteListFooter pagination={pagination} noun="people" />
                </>
              )}
            </div>
          </MemoryHubShell>
        </PageContent>
      </PullToRefresh>
    );
  }

  return <>{content}</>;
}
