import { useCallback } from 'react';

import { GlobalUID, EmptyState, LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Badge, cn } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { InsightIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';

import { useSummariesService } from '../FeedPage/useSummariesService';

export function InsightsPage() {
  const [searchParams] = useSearchParams();
  const context = searchParams.get('context') ?? '';
  const navigate = useNavigate();

  usePageTitle(context ? `${context} — Insights` : 'Insights - Companion Intelligence');

  const [{ data: summaries, loading }] = useSummariesService(50);

  const filtered = context
    ? summaries.filter((s) => {
        const haystack = [s.title, s.summaryText, ...(s.keyInsights ?? [])].join(' ').toLowerCase();

        return haystack.includes(context.toLowerCase());
      })
    : summaries;

  const handleClearContext = useCallback(() => {
    navigate('/insights', { replace: true });
  }, [navigate]);

  const handleSummaryClick = useCallback(
    (encodedId: string) => {
      navigate(`/insights/${GlobalUID.parse('summary', encodedId)}`);
    },
    [navigate],
  );

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Insights</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-2xl font-bold text-foreground">Insights &amp; Summaries</h2>
          {context && (
            <Badge
              variant="secondary"
              className="flex items-center gap-1.5 cursor-pointer hover:bg-muted/80"
              onClick={handleClearContext}
            >
              {context}
              <X className="h-3 w-3" />
            </Badge>
          )}
        </div>

        {loading && <LoadingPage />}

        {!loading && filtered.length === 0 && (
          <EmptyState
            icon={<InsightIcon size={48} colorized={false} />}
            message={context ? `No summaries found mentioning "${context}".` : 'No insights yet.'}
          />
        )}

        {!loading && filtered.length > 0 && (
          <div className="space-y-3">
            {filtered.map((summary) => (
              <SummaryRow
                key={summary.id}
                summary={summary}
                context={context}
                onClick={() => handleSummaryClick(summary.id)}
              />
            ))}
          </div>
        )}
      </PageContent>
    </>
  );
}

// ── Row component ──────────────────────────────────────────────────────────────

interface SummaryRowProps {
  summary: {
    id: string;
    title?: string | null;
    periodType: string;
    summaryText: string;
    keyInsights: string[];
    seen: boolean;
  };
  context: string;
  onClick: () => void;
}

function SummaryRow({ summary, context, onClick }: SummaryRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-xl border border-border bg-card p-4 space-y-2',
        'hover:bg-muted/40 transition-colors duration-150',
        !summary.seen && 'border-l-2 border-l-primary',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground px-2 py-0.5 rounded bg-muted">
          {summary.periodType}
        </span>
        {!summary.seen && <span className="text-xs text-primary font-medium">New</span>}
      </div>

      {summary.title && <p className="text-sm font-semibold text-foreground">{summary.title}</p>}

      <p className="text-sm text-muted-foreground line-clamp-3">
        <Highlight text={summary.summaryText} term={context} />
      </p>

      {summary.keyInsights.length > 0 && (
        <ul className="space-y-0.5">
          {summary.keyInsights.slice(0, 2).map((insight, idx) => (
            <li key={idx} className="text-xs text-muted-foreground line-clamp-1">
              · <Highlight text={insight} term={context} />
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}

// ── Inline highlight ───────────────────────────────────────────────────────────

function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) {
    return <>{text}</>;
  }

  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) {
    return <>{text}</>;
  }

  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-800 rounded-sm px-0.5">
        {text.slice(idx, idx + term.length)}
      </mark>
      {text.slice(idx + term.length)}
    </>
  );
}
