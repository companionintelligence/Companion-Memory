import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { makeFragmentData } from '@/graphql';

import { EntityGrid } from '../EntityGrid';

import { PersonGridItem, PERSON_FRAGMENT } from './PersonGridItem';

type StoryProps = ComponentProps<typeof PersonGridItem> & {
  name: string;
  description: string;
};

const meta: Meta<StoryProps> = {
  component: PersonGridItem,

  parameters: {
    layout: 'centered',
  },

  argTypes: {
    name: {
      control: 'text',
    },

    description: {
      control: 'text',
    },
  },
};

export default meta;

type Story = StoryObj<StoryProps>;

export const Default: Story = {
  args: {
    name: 'John Doe',
    description: 'A software engineer based in San Francisco.',
    onClick: fn(),
  },

  render: (args) => {
    const person = {
      __typename: 'PersonType' as const,
      id: 'mock-id-1',
      name: args.name,
      description: args.description,
    };

    const maskedPerson = makeFragmentData(person, PERSON_FRAGMENT);

    return (
      <EntityGrid>
        <PersonGridItem person={maskedPerson} onClick={args.onClick} />
      </EntityGrid>
    );
  },
};
