import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { AuthProvider } from '@/hooks';

import { LoginForm } from './LoginForm';

type Props = ComponentProps<typeof LoginForm>;

const meta: Meta<Props> = {
  component: LoginForm,
  parameters: {
    layout: 'centered',
  },
  args: {
    onSubmit: fn(),
  },
  decorators: [
    (Story) => (
      <AuthProvider args={[]}>
        <div className="min-w-100">
          <Story />
        </div>
      </AuthProvider>
    ),
  ],
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {
  args: {},
};
