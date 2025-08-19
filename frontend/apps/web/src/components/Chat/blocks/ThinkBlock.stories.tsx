import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { ThinkBlock } from '../../ChatBlocks/ThinkBlock';

type Props = ComponentProps<typeof ThinkBlock>;

const meta: Meta<Props> = {
  component: ThinkBlock,
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
    content:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
  },
};
