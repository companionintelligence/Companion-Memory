import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { BentoCard } from './BentoCard';

type Props = ComponentProps<typeof BentoCard>;

const meta: Meta<Props> = {
  component: BentoCard,
  parameters: {
    layout: 'centered',
  },
  args: {
    title: 'Favorite meal found!',
    description: (
      <div className="flex flex-col gap-4">
        <p>
          Because you mentioned Chinese Chicken Salad as a comfort food, I've recommended a well-liked recipe
          for this dish.
        </p>

        <p>I'll add it to your recipe box? Or please let me know if I've missed any details!</p>
      </div>
    ),
    tags: ['Culinary'],
    imageUrl:
      'https://hips.hearstapps.com/hmg-prod/images/crunchy-mandarin-orange-chicken-salad-lead-66677b295a6b5.jpg',
    onClick: fn(),
    onLike: fn(),
    onDislike: fn(),
    onExpand: fn(),
  },
  decorators: [(Story) => <Story />],
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {
  args: {},
};

export const NoImage: Story = {
  args: {
    imageUrl: undefined,
  },
};

export const ExtensiveTags: Story = {
  args: {
    tags: ['Culinary', 'Food', 'Cooking', 'Recommendation', 'Recipe'],
  },
};

export const ExtensiveTagsNoImage: Story = {
  args: {
    tags: ['Culinary', 'Food', 'Cooking', 'Recommendation', 'Recipe'],
    imageUrl: undefined,
  },
};
