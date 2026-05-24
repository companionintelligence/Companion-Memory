import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';

import { GlobalUID, ErrorPage, LoadingPage, Portal, useDeviceLayout, usePageTitle } from '@ci/common';
import { Breadcrumb, useToast } from '@ci/shadcn';
import { useNavigate, useParams, Link } from 'react-router-dom';

import { useActionListService, useForecastService } from '@/api';
import { useFeatures } from '@/common/feature';
import { ForecastStrip } from '@/components/ForecastStrip';
import { PageContent } from '@/components/layout';
import { Markdown } from '@/components/Markdown';
import { type FragmentType } from '@/graphql';
import { useModalControls } from '@/hooks';

import { BentoCard } from '../../components/BentoCard';
import { Carousel } from '../../components/Carousel';

import { FeedModal } from './FeedModal';
import type { INSIGHT_CARD_FRAGMENT } from './InsightCard';
import { InsightCard } from './InsightCard';
import { QuestionCard } from './QuestionCard';
import type { SUMMARY_CARD_FRAGMENT } from './SummaryCard';
import { SummaryCard } from './SummaryCard';
import { useFeedQuestionService, type FeedQuestion } from './useFeedQuestionService';
import { useSummariesService } from './useSummariesService';

type CarouselProps = Partial<ComponentProps<typeof Carousel>>;
const DISMISSED_INSIGHTS_STORAGE_KEY = 'feed:dismissed-insights:v1';
const MAX_INSIGHT_SUMMARY_CARDS = 20;

export function FeedPage() {
  usePageTitle('Feed - Companion Intelligence');

  const { isMobile } = useDeviceLayout();
  const { toast } = useToast();
  const navigate = useNavigate();

  const { id: actionId } = useParams<{ id?: string }>();
  const [{ data: actions, loading, error }, { markActionAsSeen, markActionAsDismissed }] =
    useActionListService(5);
  const [
    { data: summaries, loading: summariesLoading, error: summariesError },
    { markSummaryAsSeen, markSummaryAsDismissed },
  ] = useSummariesService();
  const [
    { question, submitting: questionSubmitting, error: questionError },
    { submitAnswer: submitQuestionAnswer },
  ] = useFeedQuestionService();
  const { isFeatureEnabled } = useFeatures();
  const hbpeEnabled = isFeatureEnabled('hbpe');
  const [{ data: forecast }] = useForecastService();
  const [dismissedActionIds, setDismissedActionIds] = useState<Set<string>>(new Set());
  const [dismissedSummaryIds, setDismissedSummaryIds] = useState<Set<string>>(new Set());
  const [dismissedInsightIds, setDismissedInsightIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISSED_INSIGHTS_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      setDismissedInsightIds(new Set(parsed.filter((value): value is string => typeof value === 'string')));
    } catch {
      setDismissedInsightIds(new Set());
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(DISMISSED_INSIGHTS_STORAGE_KEY, JSON.stringify(Array.from(dismissedInsightIds)));
  }, [dismissedInsightIds]);

  useEffect(() => {
    if (questionError == null) {
      return;
    }

    toast.error('We could not load or submit a question right now.');
  }, [questionError, toast]);

  const visibleActions = useMemo(
    () => actions.filter((action) => !action.dismissed && !dismissedActionIds.has(action.id)),
    [actions, dismissedActionIds],
  );

  const visibleSummaries = useMemo(
    () => summaries.filter((summary) => !summary.dismissed && !dismissedSummaryIds.has(summary.id)),
    [summaries, dismissedSummaryIds],
  );
  const visibleInsights = useMemo(
    () =>
      visibleSummaries.flatMap((summary) =>
        summary.insights
          .map((insight, idx) => ({
            id: `${summary.id}:${idx}`,
            summarySeen: summary.seen,
            insight,
          }))
          .filter((item) => !dismissedInsightIds.has(item.id)),
      ),
    [dismissedInsightIds, visibleSummaries],
  );
  const mixedInsightSummaryCards = useMemo(() => {
    const mixed: Array<
      | {
          kind: 'insight';
          id: string;
          insightId: string;
          isSeen: boolean;
          insight: (typeof visibleInsights)[number]['insight'];
        }
      | {
          kind: 'summary';
          id: string;
          summary: (typeof visibleSummaries)[number];
        }
    > = [];
    const max = Math.max(visibleInsights.length, visibleSummaries.length);

    for (let index = 0; index < max; index += 1) {
      const insight = visibleInsights[index];
      if (insight) {
        mixed.push({
          kind: 'insight',
          id: `insight:${insight.id}`,
          insightId: insight.id,
          isSeen: insight.summarySeen,
          insight: insight.insight,
        });
      }

      const summary = visibleSummaries[index];
      if (summary) {
        mixed.push({
          kind: 'summary',
          id: `summary:${summary.id}`,
          summary,
        });
      }
    }

    return mixed.slice(0, MAX_INSIGHT_SUMMARY_CARDS);
  }, [visibleInsights, visibleSummaries]);

  const selectedActionIndex = useMemo(
    () => visibleActions.findIndex((item) => item.id === actionId),
    [visibleActions, actionId],
  );
  const selectedActionCardIndex = selectedActionIndex;
  const actionCards = useMemo(() => {
    const cards = visibleActions.map((action) => ({
      kind: 'action' as const,
      id: action.id,
      action,
    }));

    if (!question) {
      return cards;
    }

    const questionCard = {
      kind: 'question' as const,
      id: `question:${question.presentationId}`,
      question,
    };

    return [...cards, questionCard];
  }, [question, visibleActions]);
  const isActionsRowEmpty = actionCards.length === 0;
  const isInsightsRowEmpty = mixedInsightSummaryCards.length === 0;
  const showInsightsRowEmptyState = isInsightsRowEmpty && !summariesLoading && !summariesError;
  const showMobileEmptyState = isActionsRowEmpty && showInsightsRowEmptyState;

  const [{ isOpen: isModalOpen }, { open: openModal, close: closeModal }] = useModalControls({
    open: selectedActionIndex >= 0,
  });

  useEffect(() => {
    if (selectedActionIndex >= 0) {
      openModal();
    } else {
      closeModal();
    }
  }, [closeModal, openModal, selectedActionIndex]);

  const handleCardClick = useCallback(
    async (id: string) => {
      navigate(`/feed/${id}`, { replace: true });
      openModal();
      await markActionAsSeen(id);
    },
    [markActionAsSeen, navigate, openModal],
  );

  const handleActionDismiss = useCallback(
    async (id: string) => {
      setDismissedActionIds((prev) => new Set(prev).add(id));

      if (actionId === id) {
        navigate('/feed', { replace: true });
      }

      await markActionAsDismissed(id);
    },
    [actionId, markActionAsDismissed, navigate],
  );

  const handleSummaryDismiss = useCallback(
    async (id: string) => {
      setDismissedSummaryIds((prev) => new Set(prev).add(id));
      await markSummaryAsDismissed(id);
    },
    [markSummaryAsDismissed],
  );

  const handleInsightDismiss = useCallback((insightId: string) => {
    setDismissedInsightIds((prev) => new Set(prev).add(insightId));
  }, []);

  const handleModalClose = useCallback(() => {
    navigate('/feed', { replace: true });
    closeModal();
  }, [navigate, closeModal]);

  const handleSummaryClick = useCallback(
    async (encodedId: string) => {
      await markSummaryAsSeen(encodedId);
      navigate(`/insights/${GlobalUID.parse('summary', encodedId)}`);
    },
    [markSummaryAsSeen, navigate],
  );
  const handleQuestionSubmit = useCallback(
    async ({ questionId, text }: { questionId: string; text: string }) => {
      return submitQuestionAnswer({
        questionId,
        text,
      });
    },
    [submitQuestionAnswer],
  );

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
      initialIndex: selectedActionCardIndex,
    } satisfies CarouselProps;

    return (
      <PageContent>
        {showMobileEmptyState ? (
          <div className="flex min-h-[40vh] items-center justify-center py-10">
            <p className="text-center text-xl font-medium text-muted-foreground opacity-70">All Caught Up!</p>
          </div>
        ) : (
          <Carousel {...carouselProps}>
            {actionCards.map((card) =>
              card.kind === 'question' ? (
                <QuestionCard
                  key={card.id}
                  question={card.question as FeedQuestion}
                  submitting={questionSubmitting}
                  onSubmit={handleQuestionSubmit}
                />
              ) : (
                <BentoCard
                  key={card.id}
                  title={card.action.title}
                  description={
                    <div className="prose dark:prose-invert">
                      <Markdown>{card.action.text}</Markdown>
                    </div>
                  }
                  tags={card.action.tags}
                  imageUrl={card.action.imageUrl}
                  onClick={() => void handleCardClick(card.action.id)}
                  onDismiss={() => void handleActionDismiss(card.action.id)}
                  dismissLabel="Dismiss action"
                  showUnseenIndicator={!card.action.seen}
                />
              ),
            )}

            {mixedInsightSummaryCards.map((card) =>
              card.kind === 'insight' ? (
                <InsightCard
                  key={card.id}
                  insight={card.insight as FragmentType<typeof INSIGHT_CARD_FRAGMENT>}
                  isSeen={card.isSeen}
                  onDismiss={() => handleInsightDismiss(card.insightId)}
                />
              ) : (
                <SummaryCard
                  key={card.id}
                  summary={card.summary as FragmentType<typeof SUMMARY_CARD_FRAGMENT>}
                  onClick={() => void handleSummaryClick(card.summary.id)}
                  onDismiss={() => void handleSummaryDismiss(card.summary.id)}
                />
              ),
            )}
          </Carousel>
        )}

        {summariesError && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            We could not load live insights. Preview cards are shown until the service recovers.
          </div>
        )}

        {hbpeEnabled && forecast && (
          <div className="px-2 pb-4">
            <h3 className="text-sm font-semibold text-foreground mb-2">Tomorrow's Forecast</h3>
            <ForecastStrip
              buckets={forecast.buckets}
              generatedAt={forecast.generatedAt}
              systemStatus={forecast.systemStatus}
            />
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
        {hbpeEnabled && forecast && (
          <>
            <h2 className="text-2xl font-bold text-foreground">Tomorrow's Forecast</h2>
            <ForecastStrip
              buckets={forecast.buckets}
              generatedAt={forecast.generatedAt}
              systemStatus={forecast.systemStatus}
            />
          </>
        )}

        <h2 className="text-2xl font-bold text-foreground">Actions</h2>

        {isActionsRowEmpty ? (
          <div className="flex min-h-[220px] items-center justify-center">
            <p className="text-center text-lg font-medium text-muted-foreground opacity-70">All Caught Up!</p>
          </div>
        ) : (
          <Carousel {...carouselProps} initialIndex={selectedActionCardIndex}>
            {actionCards.map((card) =>
              card.kind === 'question' ? (
                <QuestionCard
                  key={card.id}
                  question={card.question as FeedQuestion}
                  submitting={questionSubmitting}
                  onSubmit={handleQuestionSubmit}
                  className="hover:shadow-lg transition-shadow duration-200"
                />
              ) : (
                <BentoCard
                  key={card.id}
                  title={card.action.title}
                  description={
                    <div className="prose dark:prose-invert">
                      <Markdown>{card.action.text}</Markdown>
                    </div>
                  }
                  tags={card.action.tags}
                  imageUrl={card.action.imageUrl}
                  onClick={() => void handleCardClick(card.action.id)}
                  onDismiss={() => void handleActionDismiss(card.action.id)}
                  dismissLabel="Dismiss action"
                  showUnseenIndicator={!card.action.seen}
                  className="hover:shadow-lg transition-shadow duration-200"
                />
              ),
            )}
          </Carousel>
        )}

        <h2 className="text-2xl font-bold text-foreground">Insights & Summaries</h2>

        <div className="space-y-3">
          {summariesError && (
            <div className="text-sm text-destructive">
              We could not load live insights. Preview cards are shown until the service recovers.
            </div>
          )}

          {showInsightsRowEmptyState ? (
            <div className="flex min-h-[220px] items-center justify-center">
              <p className="text-center text-lg font-medium text-muted-foreground opacity-70">
                You've seen everything for now, let Companion learn and come back later
              </p>
            </div>
          ) : (
            <Carousel {...carouselProps}>
              {mixedInsightSummaryCards.map((card) =>
                card.kind === 'insight' ? (
                  <InsightCard
                    key={card.id}
                    insight={card.insight as FragmentType<typeof INSIGHT_CARD_FRAGMENT>}
                    isSeen={card.isSeen}
                    onDismiss={() => handleInsightDismiss(card.insightId)}
                    className="hover:shadow-lg transition-shadow duration-200 h-110"
                  />
                ) : (
                  <SummaryCard
                    key={card.id}
                    summary={card.summary as FragmentType<typeof SUMMARY_CARD_FRAGMENT>}
                    onClick={() => void handleSummaryClick(card.summary.id)}
                    onDismiss={() => void handleSummaryDismiss(card.summary.id)}
                    className="hover:shadow-lg transition-shadow duration-200 h-110"
                  />
                ),
              )}
            </Carousel>
          )}
        </div>
      </PageContent>

      {isModalOpen && <FeedModal onClose={handleModalClose} />}
    </>
  );
}
