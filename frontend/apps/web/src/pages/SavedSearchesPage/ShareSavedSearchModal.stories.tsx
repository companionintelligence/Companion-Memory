import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { mockSavedSearch, withApollo } from './_storyHelpers';
import { ShareSavedSearchModal } from './ShareSavedSearchModal';

const meta: Meta<typeof ShareSavedSearchModal> = {
  title: 'Saved Search/Share Modal',
  component: ShareSavedSearchModal,
  parameters: { layout: 'fullscreen' },
  decorators: [withApollo],
  args: { onClose: fn() },
};

export default meta;

type Story = StoryObj<typeof ShareSavedSearchModal>;

// Public: shows the capability link, social buttons, and iframe embed.
export const LinkShared: Story = {
  args: { savedSearch: mockSavedSearch() },
};

// Private: just the Not shared / Link shared toggle.
export const NotShared: Story = {
  args: { savedSearch: mockSavedSearch({ isPublic: false, shareToken: null }) },
};
