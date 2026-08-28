import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { AskComposer } from './AskComposer';
import { COMPOSER_SHAPES } from './composeRecipients';

const meta: Meta<typeof AskComposer> = {
  title: 'Asks/Composer',
  component: AskComposer,
  parameters: { layout: 'centered' },
  args: { onSend: fn(), shapes: COMPOSER_SHAPES },
  decorators: [
    (Story) => (
      <div className="w-[440px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AskComposer>;

/**
 * The ordinary case.
 *
 * Note what the recipients are named: a truncated opaque id, not "Sam". There
 * is no display name for a local user anywhere on this schema, and a story that
 * invented one would make the component look finished in exactly the way the
 * page refuses to.
 */
export const PickFromPeopleYouKnow: Story = {
  args: {
    recipients: [
      {
        id: 'globaluid-sam001',
        name: 'Peer …sam001',
        tier: 'on this Companion',
        why: 'you have given them a standing grant',
        autoAnswers: true,
      },
      {
        id: 'globaluid-devon2',
        name: 'Peer …devon2',
        tier: 'on this Companion',
        why: 'they have asked you something',
      },
    ],
  },
};

/**
 * Linked, and still not askable from here.
 *
 * The federated path needs a Portal-issued token this box never mints, so a
 * peer the owner just linked cannot be addressed. Shown rather than omitted:
 * silently dropping them would render "you have no relationship with this
 * person", which is a claim and not a loading state.
 */
export const LinkedPeerCannotBeAsked: Story = {
  args: {
    recipients: [],
    unreachable: [
      {
        id: 'peer-link-1',
        name: 'ada',
        avatarUrl: 'https://i.pravatar.cc/64?img=12',
        tier: 'Stranger',
        reason:
          'asking across boxes needs an access token from the Portal that your Companion cannot issue from this page yet',
      },
    ],
  },
};

/** Nobody yet — and the empty state says why there is no search box. */
export const NobodyToAsk: Story = {
  args: { recipients: [], unreachable: [] },
};
