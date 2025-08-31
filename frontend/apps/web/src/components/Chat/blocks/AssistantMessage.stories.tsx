import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { AssistantMessage } from './AssistantMessage';

type Props = ComponentProps<typeof AssistantMessage>;

const meta: Meta<Props> = {
  component: AssistantMessage,
  parameters: {
    layout: 'centered',
  },
  args: {},
  decorators: [
    (Story) => (
      <div className="w-200 border p-4">
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

export const WithImage: Story = {
  args: {
    content:
      'I\'ve generated an image for you: "A serene mountain landscape at sunset". Here it is:\n\n![Generated Image](https://via.placeholder.com/400x300/4a90e2/ffffff?text=Mountain+Landscape)\n\nThe image shows a beautiful mountain scene with vibrant colors.',
  },
};

export const WithMultipleImages: Story = {
  args: {
    content:
      "Here are a couple of images I created:\n\n![First Image](https://via.placeholder.com/300x200/e74c3c/ffffff?text=First+Image)\n\nThis is the first image showing a simple red design.\n\n![Second Image](https://via.placeholder.com/300x200/2ecc71/ffffff?text=Second+Image)\n\nAnd here's a second image with a green theme.",
  },
};
