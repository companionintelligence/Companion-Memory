import { useCallback, useMemo, useState } from 'react';

import { Portal } from '@ci/common';
import { Breadcrumb } from '@ci/shadcn';

import { type Action, useActionListService } from '@/api';
import { PageContent } from '@/components/layout';
import { useDeviceLayout, useModalControls } from '@/hooks';

import { BentoCard } from '../../components/BentoCard';
import { Carousel } from '../../components/Carousel';

import { actionInsightData, feedData } from './data';
import { FeedModal } from './FeedModal';
import type { FeedItem } from './types';

export function FeedPage() {
  const { isMobile } = useDeviceLayout();

  const [{ data: actions, loading, error }] = useActionListService();
  const [{ isOpen: isModalOpen }, { open: openModal, close: closeModal }] = useModalControls();

  const [selectedAction, setSelectedAction] = useState<Action | null>(null);
  const [selectedItem, setSelectedItem] = useState<FeedItem | null>(null);

  const handleCardClick = useCallback(
    (id: string) => {
      const action = actions.find((item) => item.id === id);
      const item = [...feedData, ...actionInsightData].find((item) => item.id === id);

      if (action) {
        setSelectedAction(action);
        setSelectedItem(null);
        openModal();
      } else if (item) {
        setSelectedAction(null);
        setSelectedItem(item);
        openModal();
      }
    },
    [actions],
  );

  const handleModalClose = useCallback(() => {
    closeModal();
    setSelectedAction(null);
    setSelectedItem(null);
  }, []);

  const carouselProps = useMemo(() => {
    if (isMobile) {
      return {
        className: 'h-full -mx-2',
        containerClassName: 'h-full',
        slideClassName: 'h-full px-2',
      };
    }

    return {
      className: '-mx-6',
      containerClassName: 'px-6 pb-6 pt-1',
      slideClassName: 'flex-none min-w-[550px] basis-[550px] mr-6',
    };
  }, [isMobile]);

  const featuredContent = useMemo(() => {
    if (isMobile) {
      return (
        <Carousel {...carouselProps} mobile={isMobile}>
          {!loading &&
            !error &&
            actions.map((action) => (
              <BentoCard
                key={action.id}
                title={action.title}
                description={action.text}
                tags={action.tags}
                imageUrl={action.imageUrl}
                mobile
                onClick={() => handleCardClick(action.id)}
              />
            ))}

          {feedData.map((item) => (
            <BentoCard
              key={item.id}
              title={item.title}
              description={item.description}
              tags={item.tags}
              imageUrl={item.imageUrl}
              mobile
              onClick={() => handleCardClick(item.id)}
            />
          ))}

          {actionInsightData.map((item) => (
            <BentoCard
              key={item.id}
              title={item.title}
              description={item.description}
              tags={item.tags}
              mobile
              onClick={() => handleCardClick(item.id)}
            />
          ))}
        </Carousel>
      );
    }

    return (
      <Carousel {...carouselProps} mobile={isMobile}>
        {!loading &&
          !error &&
          actions.map((action) => (
            <BentoCard
              key={action.id}
              title={action.title}
              description={action.text}
              tags={action.tags}
              imageUrl={action.imageUrl}
              onClick={() => handleCardClick(action.id)}
              className="hover:shadow-lg transition-shadow duration-200"
            />
          ))}

        {feedData.map((item) => (
          <BentoCard
            key={item.id}
            title={item.title}
            description={item.description}
            tags={item.tags}
            imageUrl={item.imageUrl}
            onClick={() => handleCardClick(item.id)}
            className="hover:shadow-lg transition-shadow duration-200"
          />
        ))}
      </Carousel>
    );
  }, [isMobile, carouselProps, handleCardClick]);

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Feed</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {!isMobile && <h2 className="text-2xl font-bold text-gray-900">Featured Content</h2>}

        {featuredContent}

        {!isMobile && <h2 className="text-2xl font-bold text-gray-900">Actions & Insights</h2>}

        {!isMobile && (
          <Carousel {...carouselProps} mobile={isMobile}>
            {actionInsightData.map((item) => (
              <BentoCard
                key={item.id}
                title={item.title}
                description={item.description}
                tags={item.tags}
                onClick={() => handleCardClick(item.id)}
                className="hover:shadow-lg transition-shadow duration-200"
              />
            ))}
          </Carousel>
        )}
      </PageContent>

      <FeedModal
        open={isModalOpen}
        threadId={selectedAction?.threadId}
        title={(selectedAction ?? selectedItem)?.title}
        description={selectedAction?.text ?? selectedItem?.description}
        tags={(selectedAction ?? selectedItem)?.tags}
        imageUrl={(selectedAction ?? selectedItem)?.imageUrl}
        onClose={handleModalClose}
      />
    </>
  );
}
