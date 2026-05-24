import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { makeFragmentData } from '@/graphql';

import { EntityGrid } from '../EntityGrid';

import { ConceptGridItem, CONCEPT_FRAGMENT } from './ConceptGridItem';

type StoryProps = ComponentProps<typeof ConceptGridItem> & {
  name: string;
  description: string;
};

const meta: Meta<StoryProps> = {
  component: ConceptGridItem,

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
    name: 'Software engineering',
    description: 'The study and application of engineering principles to software development.',
    onClick: fn(),
  },

  render: (args) => {
    const concept = {
      __typename: 'ConceptType' as const,
      id: 'mock-id-1',
      name: args.name,
      description: args.description,
    };

    const maskedConcept = makeFragmentData(concept, CONCEPT_FRAGMENT);

    return (
      <EntityGrid>
        <ConceptGridItem concept={maskedConcept} onClick={args.onClick} />
      </EntityGrid>
    );
  },
};
