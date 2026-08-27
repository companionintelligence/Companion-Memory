import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { AskReviewCard } from './AskReviewCard';

const meta: Meta<typeof AskReviewCard> = {
  title: 'Asks/Review Card',
  component: AskReviewCard,
  parameters: { layout: 'centered' },
  args: { onApprove: fn(), onDecline: fn(), onToggleItem: fn(), onDowngrade: fn() },
  decorators: [
    (Story) => (
      <div className="w-[440px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AskReviewCard>;

/** The everyday case: a household member asking for photos. */
export const HouseholdPhotos: Story = {
  args: {
    askerName: 'Maya',
    // Exercises the photo path — every other story leaves this unset, so
    // between them the file demonstrates both PersonAvatar branches: a real
    // photo here, deterministic initials everywhere else.
    askerAvatarUrl: 'https://i.pravatar.cc/64?img=47',
    tier: 'family',
    decision: 'covered-review',
    prompt: 'Do you have photos of us from the lake trip?',
    scopeSummary: 'Photos · 12–15 June · people: Maya, Sam, Leo, Mia',
    // The real string `searchBreadthNote` produces. A story that invents a
    // narrower one would document a card this page cannot render.
    searchBreadth:
      '“photos” is a label on the request, not a guaranteed filter — unless your Companion recognises it, this searches every kind of thing in your memory.',
    items: [
      { id: '1', type: 'photo', label: 'Lake, morning swim' },
      { id: '2', type: 'photo', label: 'Dock at sunset' },
      { id: '3', type: 'photo', label: 'Leo on the kayak', withheld: true },
      { id: '4', type: 'photo', label: 'Campfire' },
    ],
    downgrades: ['attribute', 'boolean'],
  },
};

/** No standing grant — quarantined, with a coarser answer offered instead. */
export const UnknownAsker: Story = {
  args: {
    askerName: 'Unknown asker',
    tier: 'no standing grant',
    decision: 'unreviewed',
    prompt: 'Where do you live?',
    scopeSummary: 'location · location',
    searchBreadth:
      '“location” is a label on the request, not a guaranteed filter — unless your Companion recognises it, this searches every kind of thing in your memory.',
    downgrades: ['attribute', 'existence', 'boolean'],
  },
};

/**
 * Already authorized by a standing grant. Nothing here is waiting on the
 * owner's permission — only on the answer being produced.
 */
export const PreAuthorized: Story = {
  args: {
    askerName: 'Sam',
    tier: 'known contact',
    decision: 'pre-authorized',
    prompt: 'Are you free Thursday evening?',
    scopeSummary: 'availability',
    searchBreadth: 'This ask names no data class, so it searches every kind of thing in your memory.',
    downgrades: ['existence', 'boolean'],
  },
};

/** A form that discloses no items at all — only a yes/no is on offer. */
export const BooleanOnly: Story = {
  args: {
    askerName: 'Devon',
    tier: 'known contact',
    decision: 'covered-review',
    prompt: 'Do you know Carol Chen?',
    scopeSummary: 'relationship',
    searchBreadth: 'This ask names no data class, so it searches every kind of thing in your memory.',
    downgrades: ['boolean'],
  },
};

/**
 * A federated ask that arrived SIGNED — the consent moment with the lock on it.
 *
 * The lock reads "Awaiting you" rather than "Signed", because nothing has been
 * shared yet: a verified signature proves who asked, not that they were allowed
 * to, and the weaker of the two axes is what the lock shows. Clicking it opens
 * the signature detail.
 */
export const SignedPeerAsk: Story = {
  args: {
    askerName: 'Ana',
    tier: 'trusted',
    decision: 'unreviewed',
    prompt: 'Were you at the Tuesday standup? I’m reconstructing who was there.',
    scopeSummary: 'Calendar · 19 August',
    searchBreadth: 'Your Companion recognises “calendar”, so this is confined to calendar entries.',
    items: [],
    downgrades: ['boolean'],
    consent: {
      askerName: 'Ana',
      consent: 'undecided',
      channel: {
        keyThumbprint: 'k9Bx2Qf7TzR0mLpV3sYhJ8nCwE1aUdG5oXi6ZrQtNbM',
        verifiedAt: '2026-08-26T09:14:22.000Z',
        covered: ['@method', '@target-uri', 'content-digest'],
      },
      ceiling: null,
      grantMode: 'review',
      arrivedAt: '2026-08-26T09:14:21.000Z',
      direction: 'inbound',
      hasBody: true,
    },
  },
};

/**
 * An ask made by SOFTWARE the asker delegated to, not by the asker.
 *
 * The line is its own, not a chip beside the name: "Ana is asking" and
 * "something Ana delegated to is asking" are different consent decisions, and
 * the second is the less familiar one. The label is attributed rather than
 * asserted — the asker writes it and this box never verifies it.
 */
export const DelegatedAgentAsk: Story = {
  args: {
    askerName: 'Ana',
    tier: 'trusted',
    decision: 'unreviewed',
    prompt: 'What’s on Sam’s wishlist? I’m putting together birthday options.',
    scopeSummary: 'Content · wishlist',
    searchBreadth: 'Your Companion recognises “wishlist”, so this is confined to those notes.',
    items: [],
    downgrades: ['boolean'],
    actor: { kind: 'third-party-agent', label: 'GiftFinder' },
  },
};

/** The same ask, made by the person. Same card, materially different decision. */
export const PersonAsk: Story = {
  args: {
    ...DelegatedAgentAsk.args,
    actor: { kind: 'person' },
  } as Story['args'],
};
