import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { default as NotFound } from './NotFound';

type Props = ComponentProps<typeof NotFound>;

const meta: Meta<Props> = {
  component: NotFound,
  parameters: {
    layout: 'centered',
  },
  args: {},
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {
  args: {},
};
