import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { DisclosureRelationships } from './DisclosureRelationships';
import { UNATTRIBUTED_KEY, type RelationshipSummary } from './relationshipPresentation';

const meta: Meta<typeof DisclosureRelationships> = {
  title: 'Asks/Disclosure Relationships',
  component: DisclosureRelationships,
  parameters: { layout: 'padded' },
  args: { onOpen: fn(), windowDays: 30, truncated: false, countedRows: 312 },
  decorators: [
    (Story) => (
      <div className="w-[560px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof DisclosureRelationships>;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const ANA: RelationshipSummary = {
  key: 'peer:link-9',
  askerId: null,
  peerLinkId: 'link-9',
  peerHandle: 'ana',
  total: 14,
  autoAnswered: 11,
  reviewed: 2,
  declined: 1,
  expired: 0,
  itemsDisclosed: 213,
  asksInWindow: 6,
  itemsInWindow: 46,
  firstAt: daysAgo(240),
  lastAt: daysAgo(1),
};

const SAM: RelationshipSummary = {
  key: 'user:9f2c1a77-1111-4b2a-9c3d-abcdef012345',
  askerId: '9f2c1a77-1111-4b2a-9c3d-abcdef012345',
  peerLinkId: null,
  peerHandle: null,
  total: 4,
  autoAnswered: 0,
  reviewed: 3,
  declined: 1,
  expired: 0,
  itemsDisclosed: 9,
  asksInWindow: 0,
  itemsInWindow: 0,
  firstAt: daysAgo(120),
  lastAt: daysAgo(47),
};

/** The everyday view: one busy standing grant, one quiet reviewed relationship. */
export const Default: Story = { args: { summaries: [ANA, SAM] } };

/**
 * The case the fold exists to surface: a relationship where almost everything
 * ever disclosed arrived in the current window.
 *
 * The wording states a FACT and stops. There is no enforced disclosure budget
 * behind it (#2364), and a threshold here would be a number with nothing
 * behind it.
 */
export const RecentAcceleration: Story = {
  args: {
    summaries: [
      { ...ANA, itemsDisclosed: 120, itemsInWindow: 108, asksInWindow: 12, total: 26, autoAnswered: 24 },
      SAM,
    ],
  },
};

/**
 * Disclosures whose counterparty has been erased. Kept so the totals stay
 * honest, and deliberately not merged into anybody real — the owner may act on
 * this list by revoking someone.
 */
export const WithUnattributed: Story = {
  args: {
    summaries: [
      ANA,
      {
        ...SAM,
        key: UNATTRIBUTED_KEY,
        askerId: null,
        peerLinkId: null,
        total: 3,
        autoAnswered: 2,
        reviewed: 1,
        declined: 0,
        itemsDisclosed: 5,
        itemsInWindow: 0,
      },
    ],
  },
};

/** A capped read — the totals below are floors, and the note says so. */
export const Truncated: Story = {
  args: { summaries: [ANA, SAM], truncated: true, countedRows: 5000 },
};
