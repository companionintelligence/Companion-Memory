import { useCallback, useEffect, useMemo, type ComponentProps } from 'react';

import { ErrorPage, LoadingPage, Portal, useDeviceLayout, usePageTitle } from '@ci/common';
import { Breadcrumb, cn } from '@ci/shadcn';
import { useNavigate, useParams, Link } from 'react-router-dom';

import { useActionListService, useSummariesService, type Summary } from '@/api';
import { PageContent } from '@/components/layout';
import { Markdown } from '@/components/Markdown';
import { useModalControls } from '@/hooks';

import { BentoCard } from '../../components/BentoCard';
import { Carousel } from '../../components/Carousel';

import { FeedModal } from './FeedModal';

type CarouselProps = Partial<ComponentProps<typeof Carousel>>;

const PLACEHOLDER_SUMMARIES: Summary[] = [
  {
    id: 'placeholder-summary-1',
    title: 'Daily Snapshot Preview',
    periodType: 'Daily',
    periodStart: '2024-05-01T08:00:00.000Z',
    periodEnd: '2024-05-01T20:00:00.000Z',
    summaryText:
      'Companion will highlight the conversations, meetings, and focus areas that defined your day once enough activity has been captured.',
    keyInsights: [
      'Identify the busiest part of your schedule',
      'Surface follow-ups hiding inside chats and emails',
      'Spot breaks in your routine before they become habits',
    ],
    notableEvents: [],
    anomalies: [],
    tags: ['Preview', 'Coming Soon'],
    activityCounts: {
      total: 12,
      browserActivity: 4,
      communications: 5,
      files: 3,
    },
    dailyRhythm: [],
    productivityPatterns: [],
    socialInteractions: [],
    keyAccomplishments: [],
    moodIndicators: [],
  },
  {
    id: 'placeholder-summary-2',
    title: 'Weekly Planning Preview',
    periodType: 'Weekly',
    periodStart: '2024-04-22T00:00:00.000Z',
    periodEnd: '2024-04-28T23:59:59.000Z',
    summaryText:
      'Weekly summaries will roll up the projects you touched, who you collaborated with, and the documents that need another pass.',
    keyInsights: [
      'Track which teammates you collaborated with most',
      'See the balance between creative vs. admin work',
      'Spot documents or threads that stalled out mid-week',
    ],
    notableEvents: [],
    anomalies: [],
    tags: ['Preview'],
    activityCounts: {
      total: 42,
      browserActivity: 16,
      communications: 18,
      files: 8,
    },
    dailyRhythm: [],
    productivityPatterns: [],
    socialInteractions: [],
    keyAccomplishments: [],
    moodIndicators: [],
  },
];

const PLACEHOLDER_PREFIX = 'placeholder-summary';

const isPlaceholderSummary = (summary: Summary) => summary.id.startsWith(PLACEHOLDER_PREFIX);

export function FeedPage() {
  usePageTitle('Feed - Companion Intelligence');

  const { isMobile } = useDeviceLayout();
  const navigate = useNavigate();

  const { id: actionId } = useParams<{ id?: string }>();
  const [{ data: actions, loading, error }] = useActionListService();
  const [{ data: summaries, loading: summariesLoading, error: summariesError }] = useSummariesService(10);

  const combinedSummaries = useMemo(() => [...PLACEHOLDER_SUMMARIES, ...summaries], [summaries]);

  const showPreviewMessage = !summariesLoading && !summariesError && summaries.length === 0;

  const selectedActionIndex = useMemo(
    () => actions.findIndex((item) => item.id === actionId),
    [actions, actionId],
  );

  const [{ isOpen: isModalOpen }, { open: openModal, close: closeModal }] = useModalControls({
    open: selectedActionIndex >= 0,
  });

  useEffect(() => {
    if (selectedActionIndex >= 0) {
      openModal();
    } else {
      closeModal();
    }
  }, [selectedActionIndex, openModal]);

  const handleCardClick = useCallback(
    (id: string) => {
      navigate(`/feed/${id}`, { replace: true });
      openModal();
    },
    [navigate, openModal],
  );

  const handleModalClose = useCallback(() => {
    navigate('/feed', { replace: true });
    closeModal();
  }, [navigate, closeModal]);

  const handleSummaryClick = useCallback(
    (id: string) => {
      navigate(`/insights/${id}`);
    },
    [navigate],
  );

  const formatSummaryDescription = useCallback((summary: Summary) => {
    return (
      <div className="flex flex-col gap-3">
        <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="px-2 py-0.5 rounded bg-muted">{summary.periodType}</span>
          <span className="px-2 py-0.5 rounded bg-muted">{summary.activityCounts.total} activities</span>
        </div>
        <p className="text-base text-foreground">{summary.summaryText}</p>
        {summary.keyInsights && summary.keyInsights.length > 0 && (
          <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
            {summary.keyInsights.slice(0, 3).map((insight, idx) => (
              <li key={idx}>{insight}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }, []);

  if (loading) {
    return (
      <PageContent>
        <LoadingPage />
      </PageContent>
    );
  }

  if (error) {
    return (
      <PageContent>
        <ErrorPage error={error} />
      </PageContent>
    );
  }

  if (isMobile) {
    const carouselProps = {
      className: 'h-full -mx-2',
      containerClassName: 'h-full',
      slideClassName: 'h-full px-2',
      initialIndex: selectedActionIndex,
    } satisfies CarouselProps;

    return (
      <PageContent>
        <Carousel {...carouselProps}>
          {!loading &&
            !error &&
            actions.map((action) => (
              <BentoCard
                key={action.id}
                title={action.title}
                description={
                  <div className="prose dark:prose-invert">
                    <Markdown>{action.text}</Markdown>
                  </div>
                }
                tags={action.tags}
                imageUrl={action.imageUrl}
                onClick={() => handleCardClick(action.id)}
              />
            ))}

          {combinedSummaries.map((summary) => {
            const placeholder = isPlaceholderSummary(summary);

            return (
              <BentoCard
                key={summary.id}
                title={summary.title || 'Summary'}
                description={formatSummaryDescription(summary)}
                tags={summary.tags}
                onClick={placeholder ? undefined : () => handleSummaryClick(summary.id)}
                className={placeholder ? 'cursor-default opacity-95' : undefined}
              />
            );
          })}
        </Carousel>

        {(summariesLoading || summariesError || showPreviewMessage) && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            {summariesLoading
              ? 'Fetching your personalized insights...'
              : summariesError
                ? 'We could not load live insights. Preview cards are shown until the service recovers.'
                : 'Your personalized insights will appear here soon — here is what they will look like.'}
          </div>
        )}

        {isModalOpen && <FeedModal onClose={handleModalClose} />}
      </PageContent>
    );
  }

  const carouselProps = {
    className: '-mx-6',
    containerClassName: 'px-6 pb-6 pt-1',
    slideClassName: 'flex-none min-w-[550px] basis-[550px] mr-6',
  } satisfies CarouselProps;

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
              <Breadcrumb.Page>Feed</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <h2 className="text-2xl font-bold text-foreground">Actions</h2>

        <Carousel {...carouselProps} initialIndex={selectedActionIndex}>
          {!loading &&
            !error &&
            actions.map((action) => (
              <BentoCard
                key={action.id}
                title={action.title}
                description={
                  <div className="prose dark:prose-invert">
                    <Markdown>{action.text}</Markdown>
                  </div>
                }
                tags={action.tags}
                imageUrl={action.imageUrl}
                onClick={() => handleCardClick(action.id)}
                className="hover:shadow-lg transition-shadow duration-200"
              />
            ))}
        </Carousel>

        <h2 className="text-2xl font-bold text-foreground">Insights</h2>

        <div className="space-y-3">
          {(summariesLoading || summariesError || showPreviewMessage) && (
            <div className={cn('text-sm', summariesError ? 'text-destructive' : 'text-muted-foreground')}>
              {summariesLoading
                ? 'Fetching your personalized insights...'
                : summariesError
                  ? 'We could not load live insights. Preview cards are shown until the service recovers.'
                  : 'Your personalized insights will appear here soon — here is what they will look like.'}
            </div>
          )}

          <Carousel {...carouselProps}>
            {combinedSummaries.map((summary) => {
              const placeholder = isPlaceholderSummary(summary);

              return (
                <BentoCard
                  key={summary.id}
                  title={summary.title || 'Summary'}
                  description={formatSummaryDescription(summary)}
                  tags={summary.tags}
                  onClick={placeholder ? undefined : () => handleSummaryClick(summary.id)}
                  className={cn(
                    'hover:shadow-lg transition-shadow duration-200 h-110',
                    placeholder ? 'cursor-default opacity-95' : undefined,
                  )}
                />
              );
            })}
          </Carousel>
        </div>
      </PageContent>

      {isModalOpen && <FeedModal onClose={handleModalClose} />}
    </>
  );
}
