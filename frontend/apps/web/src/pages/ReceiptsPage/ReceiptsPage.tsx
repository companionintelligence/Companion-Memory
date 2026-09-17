import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, LoadingPage, usePageTitle } from '@ci/common';
import { Badge, Input, Select } from '@ci/shadcn';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ChatAbout } from '@/components/ChatWithAgent';
import { ErrorState } from '@/components/ErrorState';
import { ReceiptIcon } from '@/components/icons';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { PullToRefresh } from '@/components/PullToRefresh';
import { gql } from '@/graphql';
import type { GetReceiptsQuery, ReceiptExtractionState } from '@/graphql/graphql';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';
import { namedChatContext } from '@/lib/agentChat';
import { formatMinor } from '@/lib/money';
import { humanizeEnum } from '@/lib/utils';

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
        className="flex w-full items-center gap-3 rounded-md border bg-card p-3 text-left transition hover:bg-accent"
      >
        <ReceiptIcon className="shrink-0" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{receipt.merchantName || 'Unknown merchant'}</span>
            {/* A receipt whose extraction never finished has no reliable total or
              lines; flag it rather than showing an empty one as if it were
              complete. */}
            {receipt.extractionState !== 'EXTRACTED' && (
              <Badge variant="secondary">{humanizeEnum(receipt.extractionState)}</Badge>
            )}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {[dateLabel, receipt.orderNumber ? `#${receipt.orderNumber}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="font-medium tabular-nums">{total ?? '—'}</div>
          <div className="text-sm text-muted-foreground">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </div>
        </div>
      </button>
    </ChatAbout>
  );
}

export function ReceiptsPage() {
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
    content = <LoadingPage />;
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
        <PageContent ref={pagination.scrollRef} className="gap-4 p-0">
          <MemoryHubShell>
            <div className="flex flex-col gap-4 px-2 pb-3 sm:px-4 sm:pb-4">
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Input
                  placeholder="Search by merchant..."
                  value={merchantQuery}
                  onChange={(e) => {
                    setMerchantQuery(e.target.value);
                    pagination.reset();
                  }}
                  // Three items (search, extraction-state select, count) never all fit
                  // one row at phone widths — full-width below `sm` lets each wrap to
                  // its own line instead of squeezing into an illegible sliver.
                  className="max-w-xl w-full flex-1 sm:w-auto"
                />

                <Select
                  value={extractionState ?? ANY}
                  onValueChange={(next) => {
                    setExtractionState(next === ANY ? null : (next as ReceiptExtractionState));
                    pagination.reset();
                  }}
                >
                  <Select.Trigger className="w-full sm:w-48" aria-label="Extraction state">
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

                <div className="text-sm text-muted-foreground">{pagination.totalCount} receipts</div>
              </div>

              {receipts.length === 0 ? (
                <EmptyState message="No receipts found" />
              ) : (
                <>
                  <div className="flex flex-col gap-2">
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
