import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { TagInput } from './TagInput';

type Props = ComponentProps<typeof TagInput>;

const meta: Meta<Props> = {
  component: TagInput,
  parameters: {
    layout: 'padded',
  },
  args: {
    tags: ['bug', 'feature', 'documentation'],
    onTagAdded: fn(async () => true),
    onTagRemoved: fn(),
  },
  decorators: [(Story) => <Story />],
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {};
