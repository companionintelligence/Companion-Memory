import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { Page } from './Page';

type PageProps = ComponentProps<typeof Page>;

const meta: Meta<PageProps> = {
  title: 'Examples/Page',
  component: Page,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;

type Story = StoryObj<PageProps>;

export const LoggedOut: Story = {};

export const LoggedIn: Story = {};
