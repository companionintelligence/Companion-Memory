import { useCallback, useEffect, useMemo, useState, type ComponentProps, type ElementType } from 'react';

import { GlobalUID, ErrorPage, LoadingPage, useDeviceLayout, usePageTitle } from '@ci/common';
import { useToast } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import { useActionListService } from '@/api';
import { useFeatures } from '@/common/feature';
import { ChatAbout } from '@/components/ChatWithAgent';
import { PageContent } from '@/components/layout';
import { Markdown } from '@/components/Markdown';
import { type FragmentType } from '@/graphql';
import { useModalControls } from '@/hooks';
import { namedChatContext } from '@/lib/agentChat';

import { BentoCard } from '../../components/BentoCard';
import { Carousel } from '../../components/Carousel';

import { ContextPromptCard } from './ContextPromptCard';
import { FeedModal } from './FeedModal';
import type { INSIGHT_CARD_FRAGMENT } from './InsightCard';
import { InsightCard } from './InsightCard';
import { QuestionCard } from './QuestionCard';
import type { SUMMARY_CARD_FRAGMENT } from './SummaryCard';
import { SummaryCard } from './SummaryCard';
import { useFeedQuestionService, type FeedQuestion } from './useFeedQuestionService';
import { useSummariesService } from './useSummariesService';

type CarouselProps = Partial<ComponentProps<typeof Carousel>>;
const MAX_INSIGHT_SUMMARY_CARDS = 20;

export interface FeedPageProps {
  /**
   * Rendered inside a host page (Calendar) that already owns the document title
   * and the page frame. PageContent is the page's scroll container
   * (`w-full h-full overflow-auto`), so nesting a second one gives the screen
   * two scrollbars and two sets of padding.
   */
  embedded?: boolean;
}

export function FeedPage({ embedded = false }: FeedPageProps = {}) {
  usePageTitle(embedded ? null : 'Brief - Companion Memory');

  const { t } = useTranslation();

  const { isMobile } = useDeviceLayout();
  const { toast } = useToast();
  const navigate = useNavigate();

  const { id: actionId } = useParams<{ id?: string }>();

  /**
   * Where this brief lives, so its own links stay inside it.
   *
   * The cards deep-link by action id and the modal writes that id into the URL.
   * Embedded in Calendar those have to address /plan/calendar, or opening a
   * card would navigate you off the page you opened it from.
   *
   * Standalone that address is /today, not the /brief this used to name: /brief
   * is a redirect into Calendar now, so opening a card would have bounced you
   * off the very page the card was on.
   */
  const basePath = embedded ? '/plan/calendar' : '/today';

  // Embedded, the host owns the frame; this keeps the column gap PageContent
  // would have supplied, and none of its padding, height or scrolling. No
  // padding on purpose — the desktop carousel bleeds with `-mx-6` against
  // PageContent's `p-6`, so padding here would double it.
  //
  // `relative` matters on all four exits: LoadingPage and ErrorPage are
  // `absolute inset-0 z-10`, and without a positioned boundary they anchor to
  // the HOST's PageContent, so a brief that is merely loading would black out
  // the schedule above it. `min-h-60` gives those overlays height to fill.
  //
  // `shrink-0` is what makes `min-h-60` safe. Setting a min-height REPLACES a
  // flex item's `min-height: auto` content-based automatic minimum, and that
  // automatic minimum is the only reason a page overflows its host and scrolls
  // rather than being squashed. Without this, schedule and brief — which
  // together exceed any normal viewport — would both compress below their
  // content, overlap each other, and push part of the page out of scroll range.
  //
  // `Frame` is a stable reference either way (a module-level component or the
  // string 'div'), so this never remounts the subtree it wraps.
  const Frame: ElementType = embedded ? 'div' : PageContent;
  const frameClassName = embedded
    ? `relative flex min-h-60 w-full min-w-0 shrink-0 flex-col ${isMobile ? 'gap-2' : 'gap-4'}`
    : undefined;
  const { isFeatureEnabled } = useFeatures();
  const actionsEnabled = isFeatureEnabled('actions');
  const [{ data: actions, loading, error }, { markActionAsSeen, markActionAsDismissed }] =
    useActionListService(5, { skip: !actionsEnabled });
  const [
    { data: summaries, loading: summariesLoading, error: summariesError },
    { markSummaryAsSeen, markSummaryAsDismissed },
  ] = useSummariesService();
  const [
    { question, submitting: questionSubmitting, error: questionError },
    { submitAnswer: submitQuestionAnswer },
  ] = useFeedQuestionService();
  const [dismissedActionIds, setDismissedActionIds] = useState<Set<string>>(new Set());
  const [dismissedSummaryIds, setDismissedSummaryIds] = useState<Set<string>>(new Set());
  // Session-only hide for rare legacy nested insights (no dedicated summary row).
  const [dismissedLegacyInsightIds, setDismissedLegacyInsightIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (questionError == null) {
      return;
    }

    toast.error('We could not load or submit a reflection right now.');
  }, [questionError, toast]);

  const visibleActions = useMemo(
    () =>
      actionsEnabled
        ? actions.filter((action) => !action.dismissed && !dismissedActionIds.has(action.id))
        : [],
    [actions, actionsEnabled, dismissedActionIds],
  );

  const activeSummaries = useMemo(
    () => summaries.filter((summary) => !summary.dismissed && !dismissedSummaryIds.has(summary.id)),
    [summaries, dismissedSummaryIds],
  );
  const insightPeriodSummaries = useMemo(
    () => activeSummaries.filter((summary) => summary.periodType === 'insight'),
    [activeSummaries],
  );
  const visibleSummaries = useMemo(
    () => activeSummaries.filter((summary) => summary.periodType !== 'insight'),
    [activeSummaries],
  );
  const visibleInsights = useMemo(() => {
    const fromInsightRows = insightPeriodSummaries.map((summary) => {
      const insight = summary.insights[0] ?? {
        title: summary.title || 'Proactive Insight',
        summaryText: summary.summaryText,
        keyActions: [] as string[],
        relevanceScore: 0,
        tags: summary.tags,
        relatedEntityIds: null as string[] | null,
      };

      return {
        id: summary.id,
        summaryId: summary.id,
        isSeen: summary.seen,
        insight,
        dismissMode: 'summary' as const,
      };
    });

    const fromNested = visibleSummaries.flatMap((summary) =>
      summary.insights
        .map((insight, idx) => ({
          id: `${summary.id}:${idx}`,
          summaryId: summary.id,
          isSeen: summary.seen,
          insight,
          dismissMode: 'legacy' as const,
        }))
        .filter((item) => !dismissedLegacyInsightIds.has(item.id)),
    );

    return [...fromInsightRows, ...fromNested];
  }, [dismissedLegacyInsightIds, insightPeriodSummaries, visibleSummaries]);
  const mixedInsightSummaryCards = useMemo(() => {
    const mixed: Array<
      | {
          kind: 'insight';
          id: string;
          insightId: string;
          summaryId: string;
          isSeen: boolean;
          dismissMode: 'summary' | 'legacy';
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
          summaryId: insight.summaryId,
          isSeen: insight.isSeen,
          dismissMode: insight.dismissMode,
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
  // Suppressed on error ON PURPOSE: "You've seen everything for now" is a claim
  // about the owner's data, and a failed query is not evidence for it. The
  // banner above the row carries the reason instead — which is why that banner
  // had to stop promising preview cards that `useSummariesService` never
  // returns (it is `|| []`, with no fallback of any kind), since between the
  // two the region said "placeholders are shown" over nothing at all.
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
      navigate(`${basePath}/${id}`, { replace: true });
      openModal();
      await markActionAsSeen(id);
    },
    [basePath, markActionAsSeen, navigate, openModal],
  );

  const handleActionDismiss = useCallback(
    async (id: string) => {
      setDismissedActionIds((prev) => new Set(prev).add(id));

      if (actionId === id) {
        navigate(basePath, { replace: true });
      }

      await markActionAsDismissed(id);
    },
    [actionId, basePath, markActionAsDismissed, navigate],
  );

  const handleSummaryDismiss = useCallback(
    async (id: string) => {
      setDismissedSummaryIds((prev) => new Set(prev).add(id));
      await markSummaryAsDismissed(id);
    },
    [markSummaryAsDismissed],
  );

  const handleInsightDismiss = useCallback(
    async (insightId: string, summaryId: string, dismissMode: 'summary' | 'legacy') => {
      if (dismissMode === 'legacy') {
        setDismissedLegacyInsightIds((prev) => new Set(prev).add(insightId));

        return;
      }

      setDismissedSummaryIds((prev) => new Set(prev).add(summaryId));
      await markSummaryAsDismissed(summaryId);
    },
    [markSummaryAsDismissed],
  );

  const handleModalClose = useCallback(() => {
    navigate(basePath, { replace: true });
    closeModal();
  }, [basePath, navigate, closeModal]);

  const handleSummaryClick = useCallback(
    async (encodedId: string) => {
      await markSummaryAsSeen(encodedId);
      navigate(`/brief/summaries/${GlobalUID.parse('summary', encodedId)}`);
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

  if (actionsEnabled && loading) {
    return (
      <Frame className={frameClassName}>
        <LoadingPage />
      </Frame>
    );
  }

  if (actionsEnabled && error) {
    return (
      <Frame className={frameClassName}>
        <ErrorPage error={error} />
      </Frame>
    );
  }

  if (isMobile) {
    const actionList = actionCards.map((card) =>
      card.kind === 'question' ? (
        <QuestionCard
          key={card.id}
          question={card.question as FeedQuestion}
          submitting={questionSubmitting}
          onSubmit={handleQuestionSubmit}
        />
      ) : (
        <ChatAbout
          key={card.id}
          context={namedChatContext({
            title: card.action.title,
            body: card.action.text,
            sourceKind: 'action',
            sourceId: card.action.id,
          })}
        >
          <BentoCard
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
            dismissLabel={t('FEED_CARD_DISMISS_ACTION')}
            showUnseenIndicator={!card.action.seen}
          />
        </ChatAbout>
      ),
    );

    const insightList = mixedInsightSummaryCards.map((card) =>
      card.kind === 'insight' ? (
        <InsightCard
          key={card.id}
          insight={card.insight as FragmentType<typeof INSIGHT_CARD_FRAGMENT>}
          isSeen={card.isSeen}
          onClick={() => void handleSummaryClick(card.summaryId)}
          onDismiss={() => void handleInsightDismiss(card.insightId, card.summaryId, card.dismissMode)}
        />
      ) : (
        <SummaryCard
          key={card.id}
          summary={card.summary as FragmentType<typeof SUMMARY_CARD_FRAGMENT>}
          onClick={() => void handleSummaryClick(card.summary.id)}
          onDismiss={() => void handleSummaryDismiss(card.summary.id)}
        />
      ),
    );

    return (
      <>
        <Frame className={frameClassName}>
          {showMobileEmptyState ? (
            <p className="py-6 text-center text-base font-medium text-muted-foreground">All Caught Up!</p>
          ) : (
            <>
              {(actionsEnabled || Boolean(question)) && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-lg font-semibold tracking-tight text-foreground">
                    {actionsEnabled ? 'Actions' : 'Reflections'}
                  </h2>
                  {isActionsRowEmpty ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">All Caught Up!</p>
                  ) : (
                    <div className="flex flex-col gap-2">{actionList}</div>
                  )}
                </section>
              )}

              <section className="flex flex-col gap-2">
                <h2 className="text-lg font-semibold tracking-tight text-foreground">Insights & Summaries</h2>
                {summariesError && (
                  <p className="text-sm text-destructive" role="alert">
                    Insights could not be loaded just now — this is a connection problem, not an empty
                    Companion.
                  </p>
                )}
                {showInsightsRowEmptyState ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    You've seen everything for now, let Companion learn and come back later
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">{insightList}</div>
                )}
              </section>
            </>
          )}
        </Frame>

        {/* Outside the frame, as the desktop exit already does it. On mobile
          FeedModal portals into the layout `content-modal` on `<main>` so it
          fills the visible content area instead of the scrolled PageContent
          origin — opening a card mid-page used to paint the chat at the top of
          the document, out of view. */}
        {isModalOpen && <FeedModal onClose={handleModalClose} />}
      </>
    );
  }

  const carouselProps = {
    className: '-mx-6',
    containerClassName: 'px-6 py-1',
    slideClassName: 'flex-none min-w-[550px] basis-[550px] mr-6',
  } satisfies CarouselProps;

  return (
    <>
      <Frame className={frameClassName}>
        <ContextPromptCard />

        {(actionsEnabled || Boolean(question)) && (
          <>
            <h2 className="text-2xl font-bold text-foreground">
              {actionsEnabled ? 'Actions' : 'Reflections'}
            </h2>

            {isActionsRowEmpty ? (
              <div className="flex min-h-[220px] items-center justify-center">
                <p className="text-center text-lg font-medium text-muted-foreground opacity-70">
                  All Caught Up!
                </p>
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
                    <ChatAbout
                      key={card.id}
                      context={namedChatContext({
                        title: card.action.title,
                        body: card.action.text,
                        sourceKind: 'action',
                        sourceId: card.action.id,
                      })}
                    >
                      <BentoCard
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
                        dismissLabel={t('FEED_CARD_DISMISS_ACTION')}
                        showUnseenIndicator={!card.action.seen}
                        className="hover:shadow-lg transition-shadow duration-200"
                      />
                    </ChatAbout>
                  ),
                )}
              </Carousel>
            )}
          </>
        )}

        <h2 className="text-2xl font-bold text-foreground">Insights & Summaries</h2>

        <div className="space-y-2">
          {summariesError && (
            <div className="text-sm text-destructive" role="alert">
              Insights could not be loaded just now — this is a connection problem, not an empty Companion.
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
                    onClick={() => void handleSummaryClick(card.summaryId)}
                    onDismiss={() =>
                      void handleInsightDismiss(card.insightId, card.summaryId, card.dismissMode)
                    }
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
      </Frame>

      {isModalOpen && <FeedModal onClose={handleModalClose} />}
    </>
  );
}
