import { Portal, ErrorPage, LoadingPage, usePageTitle } from '@ci/common';
import { Breadcrumb, Badge, Card } from '@ci/shadcn';
import { Link, useParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';

import { useSummaryService } from './useSummaryService';

export function SummaryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [{ data: summary, loading, error }] = useSummaryService(id || '');

  usePageTitle(summary?.title || 'Summary - Companion Intelligence');

  if (loading) {
    return (
      <PageContent>
        <LoadingPage />
      </PageContent>
    );
  }

  if (error || !summary) {
    return (
      <PageContent>
        <ErrorPage error={error || new Error('Summary not found')} />
      </PageContent>
    );
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const formatPeriodType = (type: string) => {
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

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
              <Breadcrumb.Link asChild>
                <Link to="/feed">Insights</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            {summary && (
              <>
                <Breadcrumb.Separator />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>{summary.title || 'Summary'}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h1 className="text-3xl font-bold text-foreground">{summary.title || 'Summary'}</h1>
              <Badge variant="secondary" className="text-sm">
                {formatPeriodType(summary.periodType)}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <div>
                <span className="font-medium">Period:</span> {formatDate(summary.periodStart)} -{' '}
                {formatDate(summary.periodEnd)}
              </div>
              <div>
                <span className="font-medium">Total Activities:</span> {summary.activityCounts.total}
              </div>
            </div>

            {summary.tags && summary.tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {summary.tags.map((tag: string, idx: number) => (
                  <Badge key={idx} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <Card className="p-6">
            <h2 className="text-xl font-semibold text-foreground">Summary</h2>
            <p className="text-base text-foreground leading-relaxed">{summary.summaryText}</p>
          </Card>

          {summary.keyInsights && summary.keyInsights.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold text-foreground">Key Insights</h2>
              <ul className="list-disc pl-6 space-y-2 text-base text-foreground">
                {summary.keyInsights.map((insight: string, idx: number) => (
                  <li key={idx}>{insight}</li>
                ))}
              </ul>
            </Card>
          )}

          {summary.notableEvents && summary.notableEvents.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold text-foreground">Notable Events</h2>
              <ul className="list-disc pl-6 space-y-2 text-base text-foreground">
                {summary.notableEvents.map((event: string, idx: number) => (
                  <li key={idx}>{event}</li>
                ))}
              </ul>
            </Card>
          )}

          {summary.anomalies && summary.anomalies.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold text-foreground">Anomalies</h2>
              <ul className="list-disc pl-6 space-y-2 text-base text-foreground">
                {summary.anomalies.map((anomaly: string, idx: number) => (
                  <li key={idx}>{anomaly}</li>
                ))}
              </ul>
            </Card>
          )}

          {summary.dailyRhythm && summary.dailyRhythm.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4 text-foreground">Daily Rhythm</h2>
              <ul className="list-disc pl-6 space-y-2 text-base text-foreground">
                {summary.dailyRhythm.map((rhythm: string, idx: number) => (
                  <li key={idx}>{rhythm}</li>
                ))}
              </ul>
            </Card>
          )}

          {summary.productivityPatterns && summary.productivityPatterns.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4 text-foreground">Productivity Patterns</h2>
              <ul className="list-disc pl-6 space-y-2 text-base text-foreground">
                {summary.productivityPatterns.map((pattern: string, idx: number) => (
                  <li key={idx}>{pattern}</li>
                ))}
              </ul>
            </Card>
          )}

          {summary.socialInteractions && summary.socialInteractions.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4 text-foreground">Social Interactions</h2>
              <ul className="list-disc pl-6 space-y-2 text-base text-foreground">
                {summary.socialInteractions.map((interaction: string, idx: number) => (
                  <li key={idx}>{interaction}</li>
                ))}
              </ul>
            </Card>
          )}

          {summary.keyAccomplishments && summary.keyAccomplishments.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4 text-foreground">Key Accomplishments</h2>
              <ul className="list-disc pl-6 space-y-2 text-base text-foreground">
                {summary.keyAccomplishments.map((accomplishment: string, idx: number) => (
                  <li key={idx}>{accomplishment}</li>
                ))}
              </ul>
            </Card>
          )}

          {summary.moodIndicators && summary.moodIndicators.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4 text-foreground">Mood Indicators</h2>
              <ul className="list-disc pl-6 space-y-2 text-base text-foreground">
                {summary.moodIndicators.map((mood: string, idx: number) => (
                  <li key={idx}>{mood}</li>
                ))}
              </ul>
            </Card>
          )}

          {((summary.activityCounts.browserActivity || 0) > 0 ||
            (summary.activityCounts.communications || 0) > 0 ||
            (summary.activityCounts.files || 0) > 0) && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4 text-foreground">Activity Breakdown</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {(summary.activityCounts.browserActivity || 0) > 0 && (
                  <div>
                    <div className="text-sm text-muted-foreground">Browser Activity</div>
                    <div className="text-2xl font-bold text-foreground">
                      {summary.activityCounts.browserActivity}
                    </div>
                  </div>
                )}
                {(summary.activityCounts.communications || 0) > 0 && (
                  <div>
                    <div className="text-sm text-muted-foreground">Communications</div>
                    <div className="text-2xl font-bold text-foreground">
                      {summary.activityCounts.communications}
                    </div>
                  </div>
                )}
                {(summary.activityCounts.files || 0) > 0 && (
                  <div>
                    <div className="text-sm text-muted-foreground">Files</div>
                    <div className="text-2xl font-bold text-foreground">{summary.activityCounts.files}</div>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </PageContent>
    </>
  );
}
