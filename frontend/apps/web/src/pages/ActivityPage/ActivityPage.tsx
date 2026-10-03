import { useState } from 'react';

import { Button } from '@ci/shadcn';

import { WebSignInRequired } from '@/components/WebSignInRequired';

import { ActivityRow } from './ActivityRow';
import { useActivity, type ActivityFilters } from './useActivity';

/**
 * The tabs, which are really three saved questions.
 *
 * "Refused" is its own tab rather than a filter buried in a menu because it is
 * the question this page exists to answer: the gate is only trustworthy if the
 * owner can see it working. "Apps" is the second: what has the borrowed harness
 * been doing while I was not watching.
 */
const TABS = [
  { key: 'all', label: 'Everything', filters: {} },
  { key: 'refused', label: 'Refused', filters: { outcome: 'refused' } },
  { key: 'apps', label: 'Apps', filters: { principal: 'managed-app' } },
] as const satisfies ReadonlyArray<{ key: string; label: string; filters: ActivityFilters }>;

type TabKey = (typeof TABS)[number]['key'];

/**
 * What software did on the owner's behalf — and what it was stopped from doing.
 *
 * `ci.tool_invocations` has had a writer, a retention cron and a reader route
 * since 2026-08-26 with no frontend consumer at all, which made the ledger
 * write-only in practice: the gate's refusals were recorded where nobody could
 * read them. Three things had to change server-side before this page could be
 * honest (a principal column, rows for transport-level refusals, and keyset
 * paging); see the migration and `McpToolService`.
 *
 * Deliberately NOT the activity timeline. `ci.activity_rollup` →
 * `activityTimeline` → `ActivityTimelineRail` already ships over eight sources,
 * none of them tool calls; that rail is "what happened in my life", this is
 * "what did software do for me". Merging them would bury refusals among
 * calendar events.
 */
export function ActivityPage() {
  const [tab, setTab] = useState<TabKey>('all');
  // `satisfies` keeps the literal keys, so the union is exhaustive and this
  // lookup cannot miss — no fallback branch to get wrong.
  const active = TABS.find((candidate) => candidate.key === tab) ?? TABS[0];

  const { rows, loading, loadingMore, error, hasMore, loadMore, needsWebSignIn } = useActivity(
    active.filters,
  );

  if (needsWebSignIn) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Activity</h1>
          <p className="text-sm text-muted-foreground">
            Every tool your appliance ran on your behalf, and everything it refused to.
          </p>
        </header>

        <WebSignInRequired>
          The activity ledger can only be read from a web sign-in. It records which key called what, so a
          device key — which is all this app signs in with — is never allowed to read it. Open Companion
          Memory in a web browser and sign in to see it.
        </WebSignInRequired>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Every tool your appliance ran on your behalf, and everything it refused to.
        </p>
      </header>

      <div className="flex gap-2" role="tablist">
        {TABS.map((candidate) => (
          <Button
            key={candidate.key}
            role="tab"
            aria-selected={candidate.key === tab}
            variant={candidate.key === tab ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTab(candidate.key)}
          >
            {candidate.label}
          </Button>
        ))}
      </div>

      {error != null && (
        <p className="text-sm text-destructive" role="alert">
          Could not load the ledger: {error}
        </p>
      )}

      {loading && rows == null && <p className="text-sm text-muted-foreground">Loading…</p>}

      {/*
        Each tab's emptiness means something different, and a single "nothing
        here" would misreport two of the three. An empty Refused tab is good
        news; an empty Apps tab means nothing is installed or nothing has run.
      */}
      {rows != null && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {tab === 'refused'
            ? 'Nothing has been refused. The gate has not had to stop anything.'
            : tab === 'apps'
              ? 'No installed app has run a tool yet.'
              : 'No tool calls recorded yet.'}
        </p>
      )}

      {rows != null && rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <ActivityRow key={row.id} row={row} />
          ))}
        </ul>
      )}

      {/*
        An explicit Older, not infinite scroll. The ledger keeps a year, and a
        page that silently walks backwards forever makes "how far back have I
        read" unanswerable.
      */}
      {hasMore && (
        <div>
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Older'}
          </Button>
        </div>
      )}
    </div>
  );
}
