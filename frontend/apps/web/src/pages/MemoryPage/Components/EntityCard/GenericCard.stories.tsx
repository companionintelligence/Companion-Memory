import type { ComponentProps } from 'react';

import { User, FileText, Lightbulb, Package } from '@ci/shadcn/icons';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { GenericCard } from './GenericCard';

type Props = ComponentProps<typeof GenericCard>;

const meta: Meta<Props> = {
  component: GenericCard,
  parameters: {
    layout: 'centered',
  },
  args: {
    title: 'Example Memory Card',
    subtitle: 'Category',
    description: 'This is a description of the memory card that provides additional context.',
    tags: ['Tag 1', 'Tag 2', 'Tag 3'],
    icon: User,
    onClick: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {
  args: {},
};

export const WithUserIcon: Story = {
  args: {
    title: 'John Doe',
    subtitle: 'Person',
    description: 'A contact person in your network.',
    tags: ['contact', 'friend', 'colleague'],
    icon: User,
  },
};

export const WithFileIcon: Story = {
  args: {
    title: 'Project Proposal.pdf',
    subtitle: 'Document',
    description: 'A document containing project details and requirements.',
    tags: ['document', 'project', 'proposal'],
    icon: FileText,
  },
};

export const WithLightbulbIcon: Story = {
  args: {
    title: 'Machine Learning Concept',
    subtitle: 'Concept',
    description: 'An idea or concept related to machine learning algorithms.',
    tags: ['concept', 'machine-learning', 'ai'],
    icon: Lightbulb,
  },
};

export const WithPackageIcon: Story = {
  args: {
    title: 'Laptop',
    subtitle: 'Thing',
    description: 'A physical object or item.',
    tags: ['laptop', 'electronics', 'hardware'],
    icon: Package,
  },
};

export const NoSubtitle: Story = {
  args: {
    subtitle: undefined,
  },
};

export const NoDescription: Story = {
  args: {
    description: undefined,
  },
};

export const NoTags: Story = {
  args: {
    tags: undefined,
  },
};

export const Minimal: Story = {
  args: {
    subtitle: undefined,
    description: undefined,
    tags: undefined,
  },
};

export const LongTitle: Story = {
  args: {
    title: 'This is a very long title that should truncate when it exceeds the available space in the card',
  },
};

export const LongDescription: Story = {
  args: {
    description:
      'This is a very long description that provides extensive details about the memory card. It contains multiple sentences and should wrap properly within the card layout. The description can be quite lengthy and should still look good.',
  },
};

export const ManyTags: Story = {
  args: {
    tags: ['Tag 1', 'Tag 2', 'Tag 3', 'Tag 4', 'Tag 5', 'Tag 6', 'Tag 7', 'Tag 8'],
  },
};
