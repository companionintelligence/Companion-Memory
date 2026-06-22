import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { makeFragmentData } from '@/graphql';

import { EntityGrid } from '../EntityGrid';

import { EventGridItem, EVENT_FRAGMENT } from './EventGridItem';

type StoryProps = ComponentProps<typeof EventGridItem> & {
  title: string;
  description: string;
};

const meta: Meta<StoryProps> = {
  component: EventGridItem,

  parameters: {
    layout: 'centered',
  },

  argTypes: {
    title: {
      control: 'text',
    },

    description: {
      control: 'text',
    },
  },
};

export default meta;

type Story = StoryObj<StoryProps>;

export const Default: Story = {
  args: {
    title: 'New York City Marathon',
    description: 'An annual marathon held in New York City. Get psyched for the exercise!',
    onClick: fn(),
  },

  render: (args) => {
    const event = {
      __typename: 'EventType' as const,
      id: 'mock-id-1',
      title: args.title,
      description: args.description,
      startTime: '2026-01-15T09:00:00Z',
      eventType: 'activity',
      locationName: 'New York City',
      sourceSystem: 'apple_calendar',
    };

    const maskedEvent = makeFragmentData(event, EVENT_FRAGMENT);

    return (
      <EntityGrid>
        <EventGridItem event={maskedEvent} onClick={args.onClick} />
      </EntityGrid>
    );
  },
};
