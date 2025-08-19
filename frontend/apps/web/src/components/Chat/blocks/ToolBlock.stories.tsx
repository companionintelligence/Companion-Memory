import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { ToolBlock } from '../../ChatBlocks/ToolBlock';

type Props = ComponentProps<typeof ToolBlock>;

const meta: Meta<Props> = {
  component: ToolBlock,
  parameters: {
    layout: 'centered',
  },
  args: {},
  decorators: [
    (Story) => (
      <div className="flex flex-col w-200 border p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {
  args: {
    toolName: 'awesomeTool',
  },
};
