import { useCallback, useState } from 'react';

import { Portal } from '@ci/common';
import { Breadcrumb } from '@ci/shadcn';

import { PageContent } from '@/components/layout';
import { useModalControls } from '@/hooks';

import { BentoCard } from '../../components/BentoCard';
import { Carousel } from '../../components/Carousel';

import { actionInsightData, feedData } from './data';
import { FeedModal } from './FeedModal';
import type { FeedItem } from './types';

export function FeedPage() {
  const [{ isOpen: isModalOpen }, { open: openModal, close: closeModal }] = useModalControls();

  const [selectedItem, setSelectedItem] = useState<FeedItem | null>(null);

  const handleCardClick = useCallback((id: string) => {
    const item = [...feedData, ...actionInsightData].find((item) => item.id === id);

    if (item) {
      setSelectedItem(item);
      openModal();
    }
  }, []);

  const handleModalClose = useCallback(() => {
    closeModal();
    setSelectedItem(null);
  }, []);

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
        <h2 className="text-2xl font-bold text-gray-900">Featured Content</h2>

        <Carousel
          className="-mx-6"
          containerClassName="px-6 pb-6 pt-1"
          slideClassName="flex-none min-w-[550px] basis-[550px] mr-6"
        >
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

        <h2 className="text-2xl font-bold text-gray-900">Actions & Insights</h2>

        <Carousel
          className="-mx-6"
          containerClassName="px-6 pb-6"
          slideClassName="flex-none min-w-[550px] basis-[550px] mr-6"
        >
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
      </PageContent>

      <FeedModal
        open={isModalOpen}
        title={selectedItem?.title}
        description={selectedItem?.description}
        tags={selectedItem?.tags}
        imageUrl={selectedItem?.imageUrl}
        onClose={handleModalClose}
      />
    </>
  );
}
