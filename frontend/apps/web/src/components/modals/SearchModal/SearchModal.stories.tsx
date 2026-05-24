import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { SearchModal } from './SearchModal';

type Props = ComponentProps<typeof SearchModal>;

const meta: Meta<Props> = {
  component: SearchModal,
  parameters: {
    layout: 'centered',
  },
  args: {
    open: true,

    onClose: fn(),
  },
  decorators: [(Story) => <Story />],
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {};
