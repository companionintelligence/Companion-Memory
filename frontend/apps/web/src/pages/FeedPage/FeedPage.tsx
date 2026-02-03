import { useCallback, useEffect, useMemo, type ComponentProps } from 'react';

import { GlobalUID, ErrorPage, LoadingPage, Portal, useDeviceLayout, usePageTitle } from '@ci/common';
import { Breadcrumb, cn } from '@ci/shadcn';
import { useNavigate, useParams, Link } from 'react-router-dom';

import { useActionListService } from '@/api';
import { PageContent } from '@/components/layout';
import { Markdown } from '@/components/Markdown';
import { useModalControls } from '@/hooks';

import { BentoCard } from '../../components/BentoCard';
import { Carousel } from '../../components/Carousel';

import { FeedModal } from './FeedModal';
import { InsightCard } from './InsightCard';
import { SummaryCard } from './SummaryCard';
import { useSummariesService } from './useSummariesService';

type CarouselProps = Partial<ComponentProps<typeof Carousel>>;

export function FeedPage() {
  usePageTitle('Feed - Companion Intelligence');

  const { isMobile } = useDeviceLayout();
  const navigate = useNavigate();

  const { id: actionId } = useParams<{ id?: string }>();
  const [{ data: actions, loading, error }, { markActionAsSeen }] = useActionListService(5);
  const [{ data: summaries, loading: summariesLoading, error: summariesError }] = useSummariesService(10);

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
      // Mark action as seen when clicked
      markActionAsSeen(id);
    },
    [navigate, openModal, markActionAsSeen],
  );

  const handleModalClose = useCallback(() => {
    navigate('/feed', { replace: true });
    closeModal();
  }, [navigate, closeModal]);

  const handleSummaryClick = useCallback(
    (encodedId: string) => {
      navigate(`/insights/${GlobalUID.parse('summary', encodedId)}`);
    },
    [navigate],
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

          {summaries.flatMap((summary) =>
            summary.insights.map((insight, idx) => (
              <InsightCard key={`${summary.id}-insight-${idx}`} insight={insight} />
            )),
          )}

          {summaries.map((summary) => (
            <SummaryCard key={summary.id} summary={summary} onClick={() => handleSummaryClick(summary.id)} />
          ))}
        </Carousel>

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
          {(summariesLoading || summariesError) && (
            <div className={cn('text-sm', summariesError ? 'text-destructive' : 'text-muted-foreground')}>
              {summariesLoading
                ? 'Fetching your personalized insights...'
                : 'We could not load live insights. Preview cards are shown until the service recovers.'}
            </div>
          )}

          <Carousel {...carouselProps}>
            {summaries.flatMap((summary) =>
              summary.insights.map((insight, idx) => (
                <InsightCard
                  key={`${summary.id}-insight-${idx}`}
                  insight={insight}
                  className="hover:shadow-lg transition-shadow duration-200 h-110"
                />
              )),
            )}
          </Carousel>
        </div>

        <h2 className="text-2xl font-bold text-foreground">Summaries</h2>

        <div className="space-y-3">
          <Carousel {...carouselProps}>
            {summaries.map((summary) => (
              <SummaryCard
                key={summary.id}
                summary={summary}
                onClick={() => handleSummaryClick(summary.id)}
                className="hover:shadow-lg transition-shadow duration-200 h-110"
              />
            ))}
          </Carousel>
        </div>
      </PageContent>

      {isModalOpen && <FeedModal onClose={handleModalClose} />}
    </>
  );
}
