import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';

import { GlobalUID, ErrorPage, LoadingPage, Portal, useDeviceLayout, usePageTitle } from '@ci/common';
import { Breadcrumb, cn, useToast } from '@ci/shadcn';
import { useNavigate, useParams, Link } from 'react-router-dom';

import { useActionListService } from '@/api';
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
  ] = useSummariesService(10);
  const [
    { question, submitting: questionSubmitting, error: questionError },
    { submitAnswer: submitQuestionAnswer },
  ] = useFeedQuestionService();
  const [questionCardInsertionIndex, setQuestionCardInsertionIndex] = useState(0);
  const [questionPlacement, setQuestionPlacement] = useState<{
    questionPresentationId: string;
    slotCount: number;
  } | null>(null);
  const lastQuestionCardInsertionIndex = useRef<number | null>(null);
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
  useEffect(() => {
    if (!question) {
      setQuestionCardInsertionIndex(0);
      setQuestionPlacement(null);

      return;
    }

    const slotCount = Math.max(1, visibleActions.length + 1);
    const sameQuestion = questionPlacement?.questionPresentationId === question.presentationId;
    const shouldRollForFirstVisibleQuestion = !sameQuestion;
    const shouldRerollWhenActionsAppear =
      sameQuestion && questionPlacement.slotCount === 1 && visibleActions.length > 0;

    if (!shouldRollForFirstVisibleQuestion && !shouldRerollWhenActionsAppear) {
      setQuestionCardInsertionIndex((previous) => Math.min(previous, visibleActions.length));

      return;
    }

    let nextIndex = Math.floor(Math.random() * slotCount);
    const previousIndex = lastQuestionCardInsertionIndex.current;

    if (slotCount > 1 && previousIndex != null && nextIndex === Math.min(previousIndex, slotCount - 1)) {
      nextIndex = (nextIndex + 1) % slotCount;
    }

    lastQuestionCardInsertionIndex.current = nextIndex;
    setQuestionCardInsertionIndex(nextIndex);
    setQuestionPlacement({
      questionPresentationId: question.presentationId,
      slotCount,
    });
  }, [question, questionPlacement, visibleActions.length]);

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

    return mixed;
  }, [visibleInsights, visibleSummaries]);

  const selectedActionIndex = useMemo(
    () => visibleActions.findIndex((item) => item.id === actionId),
    [visibleActions, actionId],
  );
  const selectedActionCardIndex = useMemo(() => {
    if (selectedActionIndex < 0) {
      return selectedActionIndex;
    }

    if (!question) {
      return selectedActionIndex;
    }

    return selectedActionIndex >= questionCardInsertionIndex ? selectedActionIndex + 1 : selectedActionIndex;
  }, [question, questionCardInsertionIndex, selectedActionIndex]);
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
    const safeInsertionIndex = Math.min(questionCardInsertionIndex, cards.length);

    return [...cards.slice(0, safeInsertionIndex), questionCard, ...cards.slice(safeInsertionIndex)];
  }, [question, questionCardInsertionIndex, visibleActions]);
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
            {!loading &&
              !error &&
              actionCards.map((card) =>
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

        {(summariesLoading || summariesError) && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            {summariesLoading
              ? 'Fetching your personalized insights...'
              : 'We could not load live insights. Preview cards are shown until the service recovers.'}
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

        {isActionsRowEmpty ? (
          <div className="flex min-h-[220px] items-center justify-center">
            <p className="text-center text-lg font-medium text-muted-foreground opacity-70">All Caught Up!</p>
          </div>
        ) : (
          <Carousel {...carouselProps} initialIndex={selectedActionCardIndex}>
            {!loading &&
              !error &&
              actionCards.map((card) =>
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
          {(summariesLoading || summariesError) && (
            <div className={cn('text-sm', summariesError ? 'text-destructive' : 'text-muted-foreground')}>
              {summariesLoading
                ? 'Fetching your personalized insights...'
                : 'We could not load live insights. Preview cards are shown until the service recovers.'}
            </div>
          )}

          {showInsightsRowEmptyState ? (
            <div className="flex min-h-[220px] items-center justify-center">
              <p className="text-center text-lg font-medium text-muted-foreground opacity-70">
                All Caught Up!
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
