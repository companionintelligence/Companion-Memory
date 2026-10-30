import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, usePageTitle } from '@ci/common';
import { Badge, Input, Select } from '@ci/shadcn';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAnswersFromDevice } from '@/api/powersync/deviceFallback';
import { ChatAbout } from '@/components/ChatWithAgent';
import { ErrorState } from '@/components/ErrorState';
import { ReceiptIcon } from '@/components/icons';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { MemoryHubPageSkeleton, RowsSkeleton } from '@/components/MemoryHub/MemoryHubSkeletons';
import { PullToRefresh } from '@/components/PullToRefresh';
import { gql } from '@/graphql';
import type { GetReceiptsQuery, ReceiptExtractionState } from '@/graphql/graphql';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';
import { namedChatContext } from '@/lib/agentChat';
import { formatMinor } from '@/lib/money';
import { humanizeEnum } from '@/lib/utils';
import { LocalTypeList } from '@/pages/MemoryPage/LocalListView/LocalTypeList';

export const PAGE_SIZE = 30;

/** Exported so tests can mock the exact document the page sends. */
export const GET_RECEIPTS = gql(`
  query GetReceipts($merchantName: String, $extractionState: ReceiptExtractionState, $first: Int, $after: String) {
    receipts(merchantName: $merchantName, extractionState: $extractionState, first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          merchantName
          purchasedAt
          totalMinor
          currency
          orderNumber
          channel
          extractionState
          lineItems {
            id
          }
        }
      }
    }
  }
`);

type ReceiptNode = GetReceiptsQuery['receipts']['edges'][number]['node'];

/** The sentinel a Select uses for "no choice", since Radix forbids an empty value. */
const ANY = '__any__';

// Listed rather than derived: `enumsAsTypes` leaves no runtime object to iterate.
const EXTRACTION_STATES = [
  'EXTRACTED',
  'PENDING',
  'MANUAL',
  'FAILED',
  'NOT_APPLICABLE',
] as const satisfies readonly ReceiptExtractionState[];

function ReceiptRowButton({ receipt, onOpen }: { receipt: ReceiptNode; onOpen: () => void }) {
  const purchasedAt = receipt.purchasedAt ? new Date(receipt.purchasedAt) : null;
  const dateLabel =
    purchasedAt && !Number.isNaN(purchasedAt.getTime()) ? purchasedAt.toLocaleDateString() : 'No date';
  const total = formatMinor(receipt.totalMinor, receipt.currency);
  const lineCount = receipt.lineItems.length;

  return (
    <ChatAbout
      context={namedChatContext({
        title: receipt.merchantName,
        body: [total, dateLabel, lineCount > 0 ? `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}` : null]
          .filter(Boolean)
          .join(' · '),
        sourceKind: 'ReceiptType',
        sourceId: receipt.id,
      })}
    >
      <button
        type="button"
        onClick={onOpen}
        data-testid="receipt-row"
        className="flex w-full items-center gap-2 rounded-md border bg-card p-2 text-left transition hover:bg-accent device:gap-3 device:p-3"
      >
        <ReceiptIcon className="h-5 w-5 shrink-0 device:h-6 device:w-6" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 device:gap-2">
            <span className="truncate text-sm font-medium device:text-base">
              {receipt.merchantName || 'Unknown merchant'}
            </span>
            {/* A receipt whose extraction never finished has no reliable total or
              lines; flag it rather than showing an empty one as if it were
              complete. */}
            {receipt.extractionState !== 'EXTRACTED' && (
              <Badge
                variant="secondary"
                className="max-w-28 truncate px-1.5 py-0 text-[10px] leading-4 device:max-w-none device:px-2.5 device:py-0.5 device:text-xs"
              >
                {humanizeEnum(receipt.extractionState)}
              </Badge>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground device:text-sm">
            {[dateLabel, receipt.orderNumber ? `#${receipt.orderNumber}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular-nums device:text-base device:font-medium">
            {total ?? '—'}
          </div>
          <div className="text-xs text-muted-foreground device:text-sm">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </div>
        </div>
      </button>
    </ChatAbout>
  );
}

/**
 * The receipts page. While the Memory server does not answer and this phone holds a synced
 * replica, the list comes from the phone (LocalTypeList), newest first, ranked for the
 * header box's `?search=` or this page's own `?q=`; otherwise from the appliance. See
 * api/powersync/deviceFallback.ts.
 */
export function ReceiptsPage() {
  const offline = useAnswersFromDevice();

  return offline ? (
    <LocalTypeList
      entityType="receipt"
      heading="Receipts"
      pageTitle="Receipts - Companion Memory"
      order="newest"
      searchParams={['search', 'q']}
    />
  ) : (
    <RemoteReceiptsPage />
  );
}

function RemoteReceiptsPage() {
  usePageTitle('Receipts - Companion Memory');

  const navigate = useNavigate();
  // `q` to stay consistent with the URL key the rest of the hub uses for its
  // free-text search box, even though this resolver's arg is specifically
  // `merchantName`.
  const [searchParams, setSearchParams] = useSearchParams();
  const merchantQuery = searchParams.get('q') ?? '';
  const setMerchantQuery = useCallback(
    (value: string) => {
      setSearchParams((params) => {
        const next = new URLSearchParams(params);

        if (value === '') {
          next.delete('q');
        } else {
          next.set('q', value);
        }

        return next;
      });
    },
    [setSearchParams],
  );
  const [extractionState, setExtractionState] = useState<ReceiptExtractionState | null>(null);

  const variables = useMemo(
    () => ({
      // `merchantName` is the only text filter the resolver takes — there is no
      // full-text `query` arg on `receipts`, so an empty box must send null
      // rather than an empty string that matches nothing.
      merchantName: merchantQuery.trim() === '' ? null : merchantQuery.trim(),
      extractionState,
      first: PAGE_SIZE,
    }),
    [extractionState, merchantQuery],
  );

  const { data, previousData, loading, error, fetchMore, refetch } = useQuery(GET_RECEIPTS, {
    variables,
    notifyOnNetworkStatusChange: true,
  });

  // Keep the last result on screen while new variables are in flight, so the
  // search input is not unmounted on the first keystroke.
  const view = data ?? previousData;
  const receipts = useMemo(() => (view?.receipts.edges ?? []).map((edge) => edge.node), [view]);

  const fetchNextPage = useCallback(
    (after: string) =>
      fetchMore({
        variables: { after },
        updateQuery: (prev, { fetchMoreResult }) => {
          if (!fetchMoreResult?.receipts) {
            return prev;
          }

          const prevEdges = prev.receipts?.edges ?? [];
          const seen = new Set(prevEdges.map((edge) => edge.cursor));

          return {
            receipts: {
              ...fetchMoreResult.receipts,
              edges: [
                ...prevEdges,
                ...fetchMoreResult.receipts.edges.filter((edge) => !seen.has(edge.cursor)),
              ],
            },
          };
        },
      }),
    [fetchMore],
  );

  const pagination = useInfiniteConnection({
    connection: view?.receipts,
    loadedCount: receipts.length,
    fetchNextPage,
  });

  let content: ReactNode | null = null;

  if (loading && view == null) {
    content = (
      <MemoryHubPageSkeleton label="Loading receipts">
        <RowsSkeleton />
      </MemoryHubPageSkeleton>
    );
  } else if (error && view == null) {
    content = (
      <ErrorState
        title="Could not load receipts"
        description="Your receipts are still here — this device could not reach them just now."
        onRetry={() => void refetch()}
      />
    );
  } else {
    content = (
      <PullToRefresh onRefresh={refetch}>
        <PageContent ref={pagination.scrollRef} className="gap-2 p-0 device:gap-4">
          <MemoryHubShell>
            <div className="flex flex-col gap-2 px-2 pb-3 device:gap-4 device:px-4 device:pb-4">
              <div
                className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-2 device:flex device:flex-row device:flex-wrap"
                data-testid="receipts-toolbar"
              >
                <Input
                  placeholder="Search by merchant..."
                  value={merchantQuery}
                  onChange={(e) => {
                    setMerchantQuery(e.target.value);
                    pagination.reset();
                  }}
                  className="min-w-0 w-full device:max-w-xl device:flex-1"
                />

                <Select
                  value={extractionState ?? ANY}
                  onValueChange={(next) => {
                    setExtractionState(next === ANY ? null : (next as ReceiptExtractionState));
                    pagination.reset();
                  }}
                >
                  <Select.Trigger
                    className="w-full min-w-0 [&>span]:truncate device:w-48"
                    aria-label="Extraction state"
                  >
                    <Select.Value placeholder="Any extraction state" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value={ANY}>Any extraction state</Select.Item>
                    {EXTRACTION_STATES.map((option) => (
                      <Select.Item key={option} value={option}>
                        {humanizeEnum(option)}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>

                <div className="col-span-2 justify-self-end text-xs text-muted-foreground device:text-sm">
                  {pagination.totalCount} receipts
                </div>
              </div>

              {receipts.length === 0 ? (
                <EmptyState message="No receipts found" />
              ) : (
                <>
                  <div className="flex flex-col gap-1.5 device:gap-2">
                    {receipts.map((receipt) => (
                      <ReceiptRowButton
                        key={receipt.id}
                        receipt={receipt}
                        onOpen={() => navigate(`/receipts/${GlobalUID.parse('receipt', receipt.id)}`)}
                      />
                    ))}
                  </div>

                  <InfiniteListFooter pagination={pagination} noun="receipts" />
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
