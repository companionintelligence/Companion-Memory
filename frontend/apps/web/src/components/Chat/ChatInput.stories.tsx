import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { ChatInput } from './ChatInput';

type Props = ComponentProps<typeof ChatInput>;

const meta: Meta<Props> = {
  component: ChatInput,
  args: {
    onSubmit: fn(),
    onAttach: fn(),
    onStop: fn(),
  },
};

export default meta;
type Story = StoryObj<Props>;

export const Default: Story = {};
