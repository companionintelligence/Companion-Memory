import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { GrantManager } from './GrantManager';

const meta: Meta<typeof GrantManager> = {
  title: 'Asks/Grant Manager',
  component: GrantManager,
  parameters: { layout: 'padded' },
  args: { onChangeMode: fn(), onSetExpiry: fn(), onRevoke: fn(), onAddGrant: fn(), onOpenHistory: fn() },
};

export default meta;
type Story = StoryObj<typeof GrantManager>;

export const Household: Story = {
  args: {
    groups: [
      {
        id: 'sam',
        // Opaque, because a LOCAL grantee has no name on the wire — see
        // groupGrants in AsksPage.tsx.
        name: 'Peer …sam001',
        tier: 'tier unknown',
        grants: [
          { id: 'g1', label: 'photos · photos', mode: 'auto', active: true },
          { id: 'g2', label: 'availability · calendar', mode: 'auto', active: true },
          { id: 'g3', label: 'content · documents', mode: 'review', active: true },
          { id: 'g4', label: 'content · health', mode: 'block', active: true },
        ],
      },
      {
        id: 'peer-link-1',
        // A PEER grantee does have one, and a real ceiling with it — and,
        // when the link resolved a photo, an avatar rather than initials.
        name: 'ada',
        avatarUrl: 'https://i.pravatar.cc/64?img=12',
        tier: 'Stranger',
        grants: [
          {
            id: 'g5',
            label: 'existence · all classes',
            mode: 'auto',
            note: 'digest only · no location',
            expiresAt: '2026-12-01T23:59:59.999Z',
            active: true,
          },
          {
            id: 'g6',
            label: 'content · location',
            mode: 'auto',
            revokedAt: '2026-08-03T00:00:00.000Z',
            active: false,
          },
          {
            // Lapsed is its own state: nobody withdrew it, it ran out. Calling
            // it "revoked" would credit the owner with a decision they never
            // made.
            id: 'g7',
            label: 'photos · photos',
            mode: 'auto',
            expiresAt: '2026-07-01T23:59:59.999Z',
            active: false,
          },
        ],
      },
    ],
  },
};

/**
 * The fallback branch, not the normal one.
 *
 * `updateAskGrant` IS wired on the page now, so the inert-controls path only
 * shows for a caller that supplies no handler — and the sentence it prints is
 * then true. It is kept as a story because the disabled state is the thing that
 * must never appear while the mutation is reachable, and vice versa.
 */
export const ModeChangesUnavailable: Story = {
  args: Household.args,
  // `onChangeMode` is supplied by `meta.args`, and Storybook's arg merge treats
  // an explicit `undefined` in a story as "leave it unset", not "remove it" —
  // which would silently render the WIRED state under an unwired story name.
  // Passing it at the call site is unambiguous.
  render: (args) => <GrantManager {...args} onChangeMode={undefined} onSetExpiry={undefined} />,
};
