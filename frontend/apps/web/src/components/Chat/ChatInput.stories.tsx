import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { ChatInput } from './ChatInput';

type Props = ComponentProps<typeof ChatInput>;

const meta: Meta<Props> = {
  component: ChatInput,
  parameters: {
    layout: 'centered',
  },
  args: {
    onRecord: fn(),
    onStop: fn(),
    onSubmit: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-150">
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
