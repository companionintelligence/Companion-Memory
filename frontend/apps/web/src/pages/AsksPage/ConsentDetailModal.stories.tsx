import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { ConsentDetailModal, type ConsentRecord } from './ConsentDetailModal';

const meta: Meta<typeof ConsentDetailModal> = {
  title: 'Asks/Consent Detail Modal',
  component: ConsentDetailModal,
  parameters: { layout: 'centered' },
  args: { onClose: fn() },
};

export default meta;
type Story = StoryObj<typeof ConsentDetailModal>;

/** A real-shaped thumbprint: 43 base64url characters, as RFC 7638 produces. */
const THUMBPRINT = 'k9Bx2Qf7TzR0mLpV3sYhJ8nCwE1aUdG5oXi6ZrQtNbM';

const SIGNED_CHANNEL = {
  keyThumbprint: THUMBPRINT,
  verifiedAt: '2026-08-26T09:14:22.000Z',
  covered: ['@method', '@target-uri', 'content-digest'],
};

const BASE: ConsentRecord = {
  askerName: 'Ana',
  consent: 'standing-grant',
  channel: SIGNED_CHANNEL,
  ceiling: 'summary',
  grantMode: 'auto',
  arrivedAt: '2026-08-26T09:14:21.000Z',
  direction: 'inbound',
  hasBody: true,
};

/**
 * The strongest case: a standing grant authorized it AND the peer's own key
 * signed the request. This is the one the docs use to explain what a signature
 * buys.
 */
export const SignedAndConsented: Story = { args: { record: BASE } };

/**
 * The COMMON case today — real consent, unsigned channel.
 *
 * `peers.requireHttpSignature` ships off, so this is what most federated
 * disclosures look like. The channel section still renders and says so in a
 * sentence: an owner who cannot tell "arrived unsigned" from "we did not record
 * how it arrived" cannot act on either.
 */
export const ConsentedButUnsigned: Story = {
  args: {
    record: {
      ...BASE,
      channel: { keyThumbprint: null, verifiedAt: null, covered: [] },
    },
  },
};

/**
 * A local ask — never crossed a network, so "unsigned" is a non-question rather
 * than a gap. The path row is what says so.
 */
export const LocalHouseholdAsk: Story = {
  args: {
    record: {
      ...BASE,
      askerName: 'Sam',
      channel: { keyThumbprint: null, verifiedAt: null, covered: [] },
      direction: 'local',
      consent: 'owner-decision',
      grantMode: null,
      ceiling: 'redacted',
    },
  },
};

/**
 * Waiting on the owner. Nothing has been shared, and the modal must not imply
 * otherwise just because the request arrived signed.
 */
export const AwaitingYourDecision: Story = {
  args: {
    record: { ...BASE, consent: 'undecided', grantMode: 'review', ceiling: null },
  },
};

/**
 * A signature that covered less than the profile requires.
 *
 * Unreachable through our own verifier — it refuses a short signature — but the
 * modal is the surface that would have to explain one, and naming the gap is
 * the whole point of `uncoveredComponents`.
 */
export const ShortSignature: Story = {
  args: {
    record: {
      ...BASE,
      channel: { ...SIGNED_CHANNEL, covered: ['@method', '@target-uri'] },
    },
  },
};
