import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, LoadingPage, useDeviceLayout, usePageTitle } from '@ci/common';
import { AlertDialog, Badge, Button, Card, Input, Select, Sheet, Tabs } from '@ci/shadcn';
import { Filter, Merge, X } from '@ci/shadcn/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ChatAbout } from '@/components/ChatWithAgent';
import { EntityGrid, ItemGridItem } from '@/components/entities';
import { ErrorState } from '@/components/ErrorState';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { ThingModal } from '@/components/modals/ThingModal';
import { PullToRefresh } from '@/components/PullToRefresh';
import { gql } from '@/graphql';
import type {
  GetItemDuplicatesQuery,
  GetThingsQuery,
  ItemCondition,
  ItemLifecycleState,
  ItemSortOrder,
} from '@/graphql/graphql';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';
import { namedChatContext } from '@/lib/agentChat';
import { humanizeEnum } from '@/lib/utils';

import { ObservationReview } from './ObservationReview';

/** Matches MemoryPage's PAGE_SIZE, and the gallery grid it renders into. */
export const PAGE_SIZE = 30;

/** Duplicate groups per page. Offset-based — the groups are recomputed per request. */
export const DUPLICATE_PAGE_SIZE = 20;

/** Exported so tests can mock the exact document the page sends. */
export const GET_THINGS = gql(`
  query GetThings(
    $query: String
    $category: String
    $brand: String
    $condition: ItemCondition
    $lifecycleState: ItemLifecycleState
    $hasIdentifier: Boolean
    $sort: ItemSortOrder
    $first: Int
    $after: String
  ) {
    items(
      query: $query
      category: $category
      brand: $brand
      condition: $condition
      lifecycleState: $lifecycleState
      hasIdentifier: $hasIdentifier
      sort: $sort
      first: $first
      after: $after
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          # Unmasked alongside the card fragment so the page can key the grid
          # and route a click without unmasking what the card selects.
          id
          name
          ...ItemGridItemData
        }
      }
    }
  }
`);

export const GET_ITEM_DUPLICATES = gql(`
  query GetItemDuplicates($limit: Int, $offset: Int) {
    itemDuplicates(limit: $limit, offset: $offset) {
      totalCount
      hasMore
      groups {
        reason
        value
        totalItems
        items {
          id
          name
          brand
          model
          category
          quantity
          lifecycleState
        }
      }
    }
  }
`);

export const MERGE_ITEMS = gql(`
  mutation MergeThings($input: MergeItemsInput!) {
    mergeItems(input: $input) {
      success
      item {
        id
        name
      }
      counts {
        identifiers
        observations
        receiptLineItems
      }
    }
  }
`);

export const REJECT_ITEM_DUPLICATES = gql(`
  mutation RejectThingDuplicates($itemIds: [ID!]!) {
    rejectItemDuplicates(itemIds: $itemIds)
  }
`);

type ThingNode = GetThingsQuery['items']['edges'][number]['node'];
type DuplicateGroup = GetItemDuplicatesQuery['itemDuplicates']['groups'][number];
type DuplicateItem = DuplicateGroup['items'][number];

/** The sentinel a Select uses for "no choice", since Radix forbids an empty value. */
const ANY = '__any__';

// `hasIdentifier` is a Boolean on the server but a THREE-way choice in the UI,
// and Radix Select values are strings — so the two real answers get sentinels
// of their own rather than being stringified booleans.
const HAS_CODE = '__has__';
const NO_CODE = '__none__';

// Listed rather than derived: `enumsAsTypes` leaves no runtime object to
// iterate, and this is also the order each menu shows.
const CONDITIONS = [
  'NEW',
  'LIKE_NEW',
  'GOOD',
  'FAIR',
  'POOR',
  'BROKEN',
  'NA',
] as const satisfies readonly ItemCondition[];

const LIFECYCLE_STATES = [
  'ACTIVE',
  'STORED',
  'LENT_OUT',
  'LOST',
  'RETURNED',
  'CONSUMED',
  'DISPOSED',
  'ARCHIVED',
] as const satisfies readonly ItemLifecycleState[];

const SORT_ORDERS = [
  'RECENTLY_SEEN',
  'RECENTLY_ACQUIRED',
  'NEWEST',
  'OLDEST',
  'NAME_ASC',
  'NAME_DESC',
  'VALUE_DESC',
  'VALUE_ASC',
] as const satisfies readonly ItemSortOrder[];

const SORT_LABELS: Record<ItemSortOrder, string> = {
  RECENTLY_SEEN: 'Recently seen',
  RECENTLY_ACQUIRED: 'Recently acquired',
  NEWEST: 'Newest',
  OLDEST: 'Oldest',
  NAME_ASC: 'Name A–Z',
  NAME_DESC: 'Name Z–A',
  VALUE_DESC: 'Most valuable',
  VALUE_ASC: 'Least valuable',
};

const DUPLICATE_REASON_LABELS: Record<DuplicateGroup['reason'], string> = {
  IDENTIFIER: 'Same code',
  PRODUCT_NAME: 'Same product',
  BRAND_MODEL: 'Same brand and model, bought the same day',
};

type FilterLayout = 'row' | 'stack';

function ThingsFilterFields({
  layout,
  category,
  brand,
  condition,
  lifecycleState,
  hasIdentifier,
  sort,
  onCategory,
  onBrand,
  onCondition,
  onLifecycleState,
  onHasIdentifier,
  onSort,
}: {
  layout: FilterLayout;
  category: string;
  brand: string;
  condition: ItemCondition | null;
  lifecycleState: ItemLifecycleState | null;
  hasIdentifier: boolean | null;
  sort: ItemSortOrder;
  onCategory: (value: string) => void;
  onBrand: (value: string) => void;
  onCondition: (value: ItemCondition | null) => void;
  onLifecycleState: (value: ItemLifecycleState | null) => void;
  onHasIdentifier: (value: boolean | null) => void;
  onSort: (value: ItemSortOrder) => void;
}) {
  const stacked = layout === 'stack';
  const inputClass = stacked ? 'w-full' : 'w-40';
  const selectClass = stacked ? 'w-full min-w-0' : 'w-44';
  const sortClass = stacked ? 'w-full min-w-0' : 'w-48';

  const field = (label: string, control: ReactNode) =>
    stacked ? (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {control}
      </div>
    ) : (
      control
    );

  return (
    <>
      {field(
        'Category',
        <Input
          aria-label="Category"
          placeholder="Category"
          value={category}
          onChange={(e) => onCategory(e.target.value)}
          className={inputClass}
        />,
      )}
      {field(
        'Brand',
        <Input
          aria-label="Brand"
          placeholder="Brand"
          value={brand}
          onChange={(e) => onBrand(e.target.value)}
          className={inputClass}
        />,
      )}
      {field(
        'Condition',
        <Select
          value={condition ?? ANY}
          onValueChange={(next) => onCondition(next === ANY ? null : (next as ItemCondition))}
        >
          <Select.Trigger className={selectClass} aria-label="Condition">
            <Select.Value placeholder="Any condition" />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={ANY}>Any condition</Select.Item>
            {CONDITIONS.map((option) => (
              <Select.Item key={option} value={option}>
                {humanizeEnum(option)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>,
      )}
      {field(
        'Status',
        <Select
          value={lifecycleState ?? ANY}
          onValueChange={(next) => onLifecycleState(next === ANY ? null : (next as ItemLifecycleState))}
        >
          <Select.Trigger className={selectClass} aria-label="Status">
            <Select.Value placeholder="Any status" />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={ANY}>Any status</Select.Item>
            {LIFECYCLE_STATES.map((option) => (
              <Select.Item key={option} value={option}>
                {humanizeEnum(option)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>,
      )}
      {field(
        'Codes',
        <Select
          value={hasIdentifier == null ? ANY : hasIdentifier ? HAS_CODE : NO_CODE}
          onValueChange={(next) => onHasIdentifier(next === ANY ? null : next === HAS_CODE)}
        >
          <Select.Trigger className={selectClass} aria-label="Codes">
            <Select.Value placeholder="Any code" />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={ANY}>Any code</Select.Item>
            <Select.Item value={HAS_CODE}>Has a code</Select.Item>
            <Select.Item value={NO_CODE}>No code</Select.Item>
          </Select.Content>
        </Select>,
      )}
      {field(
        'Sort',
        <Select value={sort} onValueChange={(next) => onSort(next as ItemSortOrder)}>
          <Select.Trigger className={sortClass} aria-label="Sort">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {SORT_ORDERS.map((option) => (
              <Select.Item key={option} value={option}>
                {SORT_LABELS[option]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>,
      )}
    </>
  );
}

function describeThing(thing: DuplicateItem): string {
  const parts = [thing.brand, thing.model, thing.category].filter(Boolean);

  return parts.length > 0 ? parts.join(' · ') : 'No brand or model recorded';
}

/**
 * One duplicate suggestion: a set of things the server collapsed onto a shared
 * code, product or brand+model, and the two answers a person can give it.
 *
 * Both answers have to STICK. `itemDuplicates` is derived — recomputed from
 * identifiers, products and brand+model on every request — so a decline that
 * went nowhere would see the identical group proposed again on the next load,
 * forever. `rejectItemDuplicates` writes every pair in the group to
 * `ci.entity_merge_blocks`, which `ObjectDuplicateService` reads before it
 * proposes anything; the same table and the same shape as the people queue's
 * `rejectPersonDuplicates`.
 */
function DuplicateGroupCard({
  group,
  onMerged,
}: {
  group: DuplicateGroup;
  onMerged: () => Promise<unknown>;
}) {
  const [mergeItems, { loading }] = useMutation(MERGE_ITEMS);
  const [rejectDuplicates, { loading: rejecting }] = useMutation(REJECT_ITEM_DUPLICATES);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // A group can be truncated (six units of a value shared by hundreds); say so
  // rather than implying the merge would cover all of them.
  const truncated = group.totalItems > group.items.length;
  const defaultTargetId = group.items[0]?.id ?? null;
  const pendingTarget = group.items.find((thing) => thing.id === pendingTargetId);

  const merge = async (targetId: string) => {
    const sourceIds = group.items.map((thing) => thing.id).filter((id) => id !== targetId);

    try {
      await mergeItems({ variables: { input: { targetId, sourceIds } } });
      setPendingTargetId(null);
      setMergeError(null);
      await onMerged();
    } catch (error) {
      // Keep the dialog open and show what went wrong instead of silently
      // closing on failure.
      setMergeError(error instanceof Error ? error.message : 'The merge failed. Please try again.');
    }
  };

  // "I own two of these" is a real answer, and until it was recorded the only
  // way to clear a wrong suggestion was to merge two things that are not the
  // same one.
  const reject = async () => {
    try {
      await rejectDuplicates({ variables: { itemIds: group.items.map((thing) => thing.id) } });
      setMergeError(null);
      await onMerged();
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Could not record that. Please try again.');
    }
  };

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Merge className="h-4 w-4" />
        <span>
          {DUPLICATE_REASON_LABELS[group.reason]}:{' '}
          <span className="font-medium text-foreground">{group.value}</span>
        </span>
      </div>

      {truncated && (
        <div className="mb-2 text-xs text-muted-foreground">
          {`Showing ${group.items.length} of ${group.totalItems} things sharing this — merging affects only the ${group.items.length} shown.`}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {group.items.map((thing) => (
          <div key={thing.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{thing.name || 'Unnamed thing'}</div>
              <div className="truncate text-sm text-muted-foreground">{describeThing(thing)}</div>
            </div>

            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => {
                setMergeError(null);
                setPendingTargetId(thing.id);
              }}
            >
              Use as the kept thing
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t pt-2">
        {mergeError && pendingTargetId == null && (
          <span className="text-sm text-destructive">{mergeError}</span>
        )}
        <Button size="sm" variant="ghost" disabled={loading || rejecting} onClick={() => void reject()}>
          {rejecting ? 'Saving…' : 'Not the same thing'}
        </Button>
        <Button
          size="sm"
          disabled={loading || rejecting || defaultTargetId == null}
          onClick={() => {
            if (defaultTargetId != null) {
              setMergeError(null);
              setPendingTargetId(defaultTargetId);
            }
          }}
        >
          Merge into one thing
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
            <AlertDialog.Title>Merge into one thing?</AlertDialog.Title>
            <AlertDialog.Description>
              {`Codes, sightings, receipt lines and object links from the other ${group.items.length - 1 === 1 ? 'thing' : `${group.items.length - 1} things`} will move onto "${pendingTarget?.name || 'Unnamed thing'}". This cannot be undone from the UI.`}
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
              {loading ? 'Merging…' : 'Merge into one thing'}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </div>
  );
}

export function ThingsPage() {
  usePageTitle('Things - Companion Memory');

  const { isMobile } = useDeviceLayout();
  const navigate = useNavigate();
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Search text is the header search box's `?search=` — it edits this page's
  // query in place (see GlobalSearchBox / isLiveSearchPath), so the page has
  // no input of its own. Living in the URL, it survives navigating away to a
  // thing and back, the way the filter-panel URLs elsewhere in the app do.
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('search') ?? '';
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [condition, setCondition] = useState<ItemCondition | null>(null);
  const [lifecycleState, setLifecycleState] = useState<ItemLifecycleState | null>(null);
  // Tri-state, not a checkbox: `null` is "don't filter", and `false` ("things
  // carrying no code at all") is a genuinely useful answer — it is the worklist
  // for anything a scanner cannot find.
  const [hasIdentifier, setHasIdentifier] = useState<boolean | null>(null);
  const [sort, setSort] = useState<ItemSortOrder>('RECENTLY_SEEN');
  const [createOpen, setCreateOpen] = useState(false);

  const variables = useMemo(
    () => ({
      // Empty strings are not "no filter" on the server — they are a filter
      // that matches everything with an empty value. Send null instead.
      query: searchQuery.trim() === '' ? null : searchQuery.trim(),
      category: category.trim() === '' ? null : category.trim(),
      brand: brand.trim() === '' ? null : brand.trim(),
      condition,
      lifecycleState,
      hasIdentifier,
      sort,
      first: PAGE_SIZE,
    }),
    [brand, category, condition, hasIdentifier, lifecycleState, searchQuery, sort],
  );

  const { data, previousData, loading, error, fetchMore, refetch } = useQuery(GET_THINGS, {
    variables,
    notifyOnNetworkStatusChange: true,
  });

  // Pages fetched, not groups rendered: the offset space belongs to the server's
  // own recomputation, so counting what is on screen would walk it backwards.
  const [duplicatePages, setDuplicatePages] = useState(1);
  const {
    data: duplicatesData,
    error: duplicatesError,
    refetch: refetchDuplicates,
    fetchMore: fetchMoreDuplicates,
  } = useQuery(GET_ITEM_DUPLICATES, {
    variables: { limit: DUPLICATE_PAGE_SIZE, offset: 0 },
    notifyOnNetworkStatusChange: true,
  });

  // Keep the previous result on screen while new variables are in flight —
  // swapping to a full-page loader would unmount the search input and drop
  // focus on the first keystroke of every new query.
  const view = data ?? previousData;
  const things: ThingNode[] = useMemo(() => (view?.items.edges ?? []).map((edge) => edge.node), [view]);
  const totalCount = view?.items.totalCount ?? 0;

  const duplicates = duplicatesData?.itemDuplicates;
  const duplicateGroups = duplicates?.groups ?? [];

  const fetchNextPage = useCallback(
    (after: string) =>
      fetchMore({
        variables: { after },
        updateQuery: (prev, { fetchMoreResult }) => {
          if (!fetchMoreResult?.items) {
            return prev;
          }

          const prevEdges = prev.items?.edges ?? [];
          const seen = new Set(prevEdges.map((edge) => edge.cursor));

          return {
            items: {
              ...fetchMoreResult.items,
              edges: [...prevEdges, ...fetchMoreResult.items.edges.filter((edge) => !seen.has(edge.cursor))],
            },
          };
        },
      }),
    [fetchMore],
  );

  const pagination = useInfiniteConnection({
    connection: view?.items,
    loadedCount: things.length,
    fetchNextPage,
  });

  const markFilterChanged = useCallback(() => {
    pagination.reset();
  }, [pagination.reset]);

  const activeFilterChips = useMemo(() => {
    const chips: Array<{ id: string; label: string; onClear: () => void }> = [];

    if (category.trim()) {
      chips.push({
        id: 'category',
        label: category.trim(),
        onClear: () => {
          setCategory('');
          markFilterChanged();
        },
      });
    }

    if (brand.trim()) {
      chips.push({
        id: 'brand',
        label: brand.trim(),
        onClear: () => {
          setBrand('');
          markFilterChanged();
        },
      });
    }

    if (condition) {
      chips.push({
        id: 'condition',
        label: humanizeEnum(condition) ?? condition,
        onClear: () => {
          setCondition(null);
          markFilterChanged();
        },
      });
    }

    if (lifecycleState) {
      chips.push({
        id: 'status',
        label: humanizeEnum(lifecycleState) ?? lifecycleState,
        onClear: () => {
          setLifecycleState(null);
          markFilterChanged();
        },
      });
    }

    if (hasIdentifier != null) {
      chips.push({
        id: 'codes',
        label: hasIdentifier ? 'Has a code' : 'No code',
        onClear: () => {
          setHasIdentifier(null);
          markFilterChanged();
        },
      });
    }

    if (sort !== 'RECENTLY_SEEN') {
      chips.push({
        id: 'sort',
        label: SORT_LABELS[sort],
        onClear: () => {
          setSort('RECENTLY_SEEN');
          markFilterChanged();
        },
      });
    }

    return chips;
  }, [brand, category, condition, hasIdentifier, lifecycleState, markFilterChanged, sort]);

  const filterFieldProps = {
    category,
    brand,
    condition,
    lifecycleState,
    hasIdentifier,
    sort,
    onCategory: (value: string) => {
      setCategory(value);
      markFilterChanged();
    },
    onBrand: (value: string) => {
      setBrand(value);
      markFilterChanged();
    },
    onCondition: (value: ItemCondition | null) => {
      setCondition(value);
      markFilterChanged();
    },
    onLifecycleState: (value: ItemLifecycleState | null) => {
      setLifecycleState(value);
      markFilterChanged();
    },
    onHasIdentifier: (value: boolean | null) => {
      setHasIdentifier(value);
      markFilterChanged();
    },
    onSort: (value: ItemSortOrder) => {
      setSort(value);
      markFilterChanged();
    },
  };

  const loadMoreDuplicates = () => {
    setDuplicatePages((pages) => pages + 1);

    void fetchMoreDuplicates({
      variables: { offset: duplicatePages * DUPLICATE_PAGE_SIZE },
      updateQuery: (prev, { fetchMoreResult }) => {
        if (!fetchMoreResult?.itemDuplicates) {
          return prev;
        }

        const seen = new Set(
          (prev.itemDuplicates?.groups ?? []).map((group) => `${group.reason}:${group.value}`),
        );

        return {
          itemDuplicates: {
            ...fetchMoreResult.itemDuplicates,
            groups: [
              ...(prev.itemDuplicates?.groups ?? []),
              ...fetchMoreResult.itemDuplicates.groups.filter(
                (group) => !seen.has(`${group.reason}:${group.value}`),
              ),
            ],
          },
        };
      },
    });
  };

  // A merge changes both lists — the merged-away things leave the browse, and
  // the group that proposed them is gone. Refetch both rather than patching the
  // cache by hand; the browse carries at most a few pages here, and a
  // hand-written splice would have to keep totalCount honest too.
  const onMerged = useCallback(async () => {
    setDuplicatePages(1);
    await Promise.all([refetch(), refetchDuplicates({ limit: DUPLICATE_PAGE_SIZE, offset: 0 })]);
  }, [refetch, refetchDuplicates]);

  let content: ReactNode | null = null;

  if (loading && view == null) {
    content = <LoadingPage />;
  } else if (error && view == null) {
    // Was the same confident EmptyState the genuine "No things found" branch
    // below uses — a fetch failure read identically to "you have none", with
    // no retry. ErrorState is the shared alternative (see its docblock).
    content = (
      <ErrorState
        title="Could not load things"
        description="Your things are still here — this device could not reach them just now."
        onRetry={() => void refetch()}
      />
    );
  } else {
    content = (
      <PullToRefresh onRefresh={refetch}>
        <PageContent ref={pagination.scrollRef} className="gap-4 p-0">
          <MemoryHubShell
            actions={
              isMobile ? undefined : (
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  New thing
                </Button>
              )
            }
          >
            <Tabs defaultValue="things" className="flex flex-col gap-4 px-2 pb-3 sm:px-4 sm:pb-4">
              <Tabs.List className="self-start">
                <Tabs.Trigger value="things">Things</Tabs.Trigger>
                <Tabs.Trigger value="review">Review sightings</Tabs.Trigger>
              </Tabs.List>

              <Tabs.Content value="things" className="flex flex-col gap-4">
                <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                  <div className="text-sm text-muted-foreground">{totalCount} things</div>
                  {isMobile ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setFiltersOpen(true)}
                    >
                      <Filter className="h-4 w-4" />
                      Filters
                      {activeFilterChips.length > 0 ? (
                        <Badge variant="secondary">{activeFilterChips.length}</Badge>
                      ) : null}
                    </Button>
                  ) : null}
                </div>

                {isMobile && activeFilterChips.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {activeFilterChips.map((chip) => (
                      <Badge key={chip.id} variant="secondary" className="gap-1 pr-1 font-normal">
                        {chip.label}
                        <button
                          type="button"
                          aria-label={`Clear ${chip.label}`}
                          className="rounded-sm p-0.5 hover:bg-muted"
                          onClick={chip.onClear}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : null}

                {isMobile ? (
                  <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
                    <Sheet.Content
                      side="bottom"
                      className="bottom-0 max-h-[min(85dvh,var(--vv-height,100dvh))] rounded-b-none pb-[max(1rem,var(--safe-area-bottom),var(--keyboard-inset,0px))] gap-0"
                    >
                      <Sheet.Header>
                        <Sheet.Title>Filter things</Sheet.Title>
                        <Sheet.Description>
                          Narrow the list by category, brand, condition, or code.
                        </Sheet.Description>
                      </Sheet.Header>
                      <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
                        <ThingsFilterFields layout="stack" {...filterFieldProps} />
                      </div>
                      <Sheet.Footer className="flex-row justify-between">
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={activeFilterChips.length === 0}
                          onClick={() => {
                            setCategory('');
                            setBrand('');
                            setCondition(null);
                            setLifecycleState(null);
                            setHasIdentifier(null);
                            setSort('RECENTLY_SEEN');
                            markFilterChanged();
                          }}
                        >
                          Clear all
                        </Button>
                        <Sheet.Close asChild>
                          <Button type="button">Done</Button>
                        </Sheet.Close>
                      </Sheet.Footer>
                    </Sheet.Content>
                  </Sheet>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <ThingsFilterFields layout="row" {...filterFieldProps} />
                  </div>
                )}

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
                        <Badge variant="secondary">{duplicates?.totalCount ?? 0}</Badge>
                      </Card.Title>
                      <Card.Description>
                        These things share a code, a product, or a brand and model bought the same day.
                      </Card.Description>
                    </Card.Header>
                    {/* The list grows with every "Load more"; capped so the things
                      list below stays reachable without scrolling past dozens of groups. */}
                    <Card.Content className="flex max-h-[40em] flex-col gap-3 overflow-y-auto">
                      {duplicateGroups.map((group) => (
                        <DuplicateGroupCard
                          key={`${group.reason}:${group.value}`}
                          group={group}
                          onMerged={onMerged}
                        />
                      ))}

                      {duplicates?.hasMore && (
                        <div className="flex justify-center">
                          <Button variant="outline" size="sm" onClick={loadMoreDuplicates}>
                            Load more duplicate groups
                          </Button>
                        </div>
                      )}

                      <div className="text-center text-xs text-muted-foreground">
                        {duplicateGroups.length} of {duplicates?.totalCount ?? 0} groups shown
                      </div>
                    </Card.Content>
                  </Card>
                )}

                {things.length === 0 ? (
                  <div className="relative min-h-[12rem]">
                    <EmptyState message="No things found" />
                  </div>
                ) : (
                  <>
                    <EntityGrid>
                      {things.map((thing) => (
                        <ChatAbout
                          key={thing.id}
                          className="h-full min-w-0"
                          context={namedChatContext({
                            title: thing.name,
                            body: null,
                            sourceKind: 'ItemType',
                            sourceId: thing.id,
                          })}
                        >
                          <ItemGridItem
                            item={thing}
                            onClick={() => navigate(`/items/${GlobalUID.parse('item', thing.id)}`)}
                          />
                        </ChatAbout>
                      ))}
                    </EntityGrid>

                    <InfiniteListFooter pagination={pagination} noun="things" />
                  </>
                )}
              </Tabs.Content>

              <Tabs.Content value="review">
                <ObservationReview onResolved={() => refetch()} />
              </Tabs.Content>
            </Tabs>
          </MemoryHubShell>

          <ThingModal
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            item={null}
            create
            onSaved={() => refetch()}
          />
        </PageContent>
      </PullToRefresh>
    );
  }

  return <>{content}</>;
}
