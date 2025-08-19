import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { ChatMessage } from './ChatMessage';

type Props = ComponentProps<typeof ChatMessage>;

const meta: Meta<Props> = {
  component: ChatMessage,
  parameters: {
    layout: 'centered',
  },
  args: {},
  decorators: [
    (Story) => (
      <div className="flex flex-col w-200 border p-4 gap-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<Props>;

export const UserMessage: Story = {
  args: {
    role: 'user',
    content:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
  },
};

export const AssistantMessage: Story = {
  args: {
    role: 'assistant',
    content:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
  },
};

export const ToolMessage: Story = {
  args: {
    role: 'tool',
    content:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
  },
};

export const AssistantMessageWithThinking: Story = {
  args: {
    role: 'assistant',
    content:
      '<think>I am a helpful assistant, I can see what the user might be thinking. Hmmm... what lorem text to generate to help?</think>Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
  },
};

export const AssistantMessageWithEmbeddedTools: Story = {
  args: {
    role: 'assistant',
    content:
      '<tool>awesomeTool</tool>Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
  },
};

export const AssistantMessageWithThinkingAndEmbeddedTools: Story = {
  args: {
    role: 'assistant',
    content:
      '<think>I am a helpful assistant, I can see what the user might be thinking. Hmmm... what lorem text to generate to help?</think><tool>awesomeTool</tool>Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
  },
};
