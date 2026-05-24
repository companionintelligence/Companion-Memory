import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { makeFragmentData } from '@/graphql';

import { EntityGrid } from '../EntityGrid';

import { ActionGridItem, ACTION_FRAGMENT } from './ActionGridItem';

type StoryProps = ComponentProps<typeof ActionGridItem> & {
  actionTitle: string;
  actionText: string;
};

const meta: Meta<StoryProps> = {
  component: ActionGridItem,

  parameters: {
    layout: 'centered',
  },

  argTypes: {
    actionTitle: {
      control: 'text',
    },

    actionText: {
      control: 'text',
    },
  },
};

export default meta;

type Story = StoryObj<StoryProps>;

export const Default: Story = {
  args: {
    actionTitle: 'Sample action',
    actionText: 'Sample action text goes here.',
    onClick: fn(),
  },

  render: (args) => {
    const action = {
      __typename: 'ActionType' as const,
      id: 'mock-id-1',
      actionTitle: args.actionTitle,
      actionText: args.actionText,
    };

    const maskedAction = makeFragmentData(action, ACTION_FRAGMENT);

    return (
      <EntityGrid>
        <ActionGridItem action={maskedAction} onClick={args.onClick} />
      </EntityGrid>
    );
  },
};
