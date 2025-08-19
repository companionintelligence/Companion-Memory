import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { ChatLoader } from './ChatLoader';

type Props = ComponentProps<typeof ChatLoader>;

const meta: Meta<Props> = {
  component: ChatLoader,
  parameters: {
    layout: 'centered',
  },
  args: {},
  decorators: [
    (Story) => (
      <div className="relative">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {
  args: {},
};
