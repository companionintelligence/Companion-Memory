import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { makeFragmentData } from '@/graphql';

import { EntityGrid } from '../EntityGrid';

import { ContentGridItem, CONTENT_FRAGMENT } from './ContentGridItem';

type StoryProps = ComponentProps<typeof ContentGridItem> & {
  title: string;
  text: string;
};

const meta: Meta<StoryProps> = {
  component: ContentGridItem,

  parameters: {
    layout: 'centered',
  },

  argTypes: {
    title: {
      control: 'text',
    },

    text: {
      control: 'text',
    },
  },
};

export default meta;

type Story = StoryObj<StoryProps>;

export const Default: Story = {
  args: {
    title: 'Playlist name',
    text: 'Some sample content',
    onClick: fn(),
  },

  render: (args) => {
    const content = {
      __typename: 'ContentType' as const,
      id: 'mock-id-1',
      title: args.title,
      text: args.text,
    };

    const maskedContent = makeFragmentData(content, CONTENT_FRAGMENT);

    return (
      <EntityGrid>
        <ContentGridItem content={maskedContent} onClick={args.onClick} />
      </EntityGrid>
    );
  },
};
