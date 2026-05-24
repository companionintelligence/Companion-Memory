import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { Card } from './Card';

type StoryProps = ComponentProps<typeof Card> & {
  backgroundColor: string;
  borderColor: string;
};

const meta: Meta<StoryProps> = {
  component: Card,

  parameters: {
    layout: 'centered',
  },

  argTypes: {
    borderColor: {
      control: 'text',
    },

    backgroundColor: {
      control: 'text',
    },

    disabled: {
      control: 'boolean',
    },
  },
};

export default meta;

type Story = StoryObj<StoryProps>;

export const Default: Story = {
  args: {
    backgroundColor: '#a78bfa',
    borderColor: '#c4b5fd',
    text: 'Link your Google account for quick access to Gmail, Calendar, Drive, Photos, and Youtube. Everything you need, always in sync.',
    disabled: false,
  },

  render: (args) => {
    return (
      <div className="max-w-[1040px] mx-auto mb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-4">
          <Card
            background={args.backgroundColor}
            border={args.borderColor}
            logo=""
            text={args.text}
            disabled={args.disabled}
          />
        </div>
      </div>
    );
  },
};
