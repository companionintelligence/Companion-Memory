import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { AnswerCard } from './AnswerCard';

const meta: Meta<typeof AnswerCard> = {
  title: 'Asks/Answer Card',
  component: AnswerCard,
  parameters: { layout: 'centered' },
  args: { onSave: fn(), onThank: fn() },
  decorators: [
    (Story) => (
      <div className="w-[440px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AnswerCard>;

/**
 * The RESPONDER's own view, reviewed by hand, with some items held back.
 *
 * A consent basis and real magnitudes only ever appear together like this:
 * `AskAnswerType.toType` sends both to the responder and neither to the asker.
 */
export const ReviewedWithWithheld: Story = {
  args: {
    responderName: 'Sam',
    summary: 'Sam shared 3 items.',
    items: [
      { id: '1', type: 'photo', label: 'photo …a3f2b1' },
      { id: '2', type: 'photo', label: 'photo …7c14de' },
      { id: '3', type: 'photo', label: 'photo …0b9e52' },
    ],
    disclosedCount: 3,
    withheldCount: 2,
    review: 'reviewed',
    consentBasis: 'your family grant',
  },
};

/** Auto-answered under a standing grant — the provenance must not claim review. */
export const AutoAnswered: Story = {
  args: {
    responderName: 'Devon',
    summary: 'Devon has 1 free slot Friday (longest 90 min).',
    disclosedCount: 1,
    withheldCount: 0,
    review: 'auto',
    consentBasis: 'your calendar grant',
  },
};

/**
 * The ASKER's view of a non-itemizing answer — the shape the outbox renders.
 *
 * Everything narrowed at once, because the projection narrows it all at once:
 * no consent basis, masked counts, and no auto/reviewed flag to read. The card
 * must claim none of the three rather than default any of them to a friendly
 * value.
 */
export const AskerViewWithheldCounts: Story = {
  args: {
    responderName: 'Sam',
    summary: 'Sam confirmed a match.',
    disclosedCount: 0,
    withheldCount: 0,
    review: 'undisclosed',
    countsWithheld: true,
    consentBasis: null,
  },
};
