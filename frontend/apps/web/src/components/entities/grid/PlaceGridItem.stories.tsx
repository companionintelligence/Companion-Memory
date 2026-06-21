import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { makeFragmentData } from '@/graphql';

import { EntityGrid } from '../EntityGrid';

import { PlaceGridItem, PLACE_FRAGMENT } from './PlaceGridItem';

type StoryProps = ComponentProps<typeof PlaceGridItem> & {
  name: string;
  description: string;
};

const meta: Meta<StoryProps> = {
  component: PlaceGridItem,

  parameters: {
    layout: 'centered',
  },

  argTypes: {
    name: {
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
    name: 'Central Park',
    description: 'A large public park in New York City.',
    onClick: fn(),
  },

  render: (args) => {
    const place = {
      __typename: 'PlaceType' as const,
      id: 'mock-id-1',
      name: args.name,
      description: args.description,
      properties: { latitude: 37.7749, longitude: -122.4194 },
    };

    const maskedPlace = makeFragmentData(place, PLACE_FRAGMENT);

    return (
      <EntityGrid>
        <PlaceGridItem place={maskedPlace} onClick={args.onClick} />
      </EntityGrid>
    );
  },
};
