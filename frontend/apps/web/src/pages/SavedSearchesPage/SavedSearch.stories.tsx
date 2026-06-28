import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { mockSavedSearch } from './_storyHelpers';
import { SavedSearch } from './SavedSearch';

const meta: Meta<typeof SavedSearch> = {
  title: 'Saved Search/Card',
  component: SavedSearch,
  parameters: { layout: 'centered' },
  args: {
    openSavedSearchEditModal: fn(),
    openSavedSearchShareModal: fn(),
    openSavedSearchDeleteModal: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[300px] w-[400px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SavedSearch>;

// Shared + filtered: the "Shared" badge and the filter-count chip both show.
export const SharedAndFiltered: Story = {
  args: { savedSearch: mockSavedSearch() },
};

export const Plain: Story = {
  args: {
    savedSearch: mockSavedSearch({
      name: 'Unread work email',
      isPublic: false,
      shareToken: null,
      filters: null,
      entityTypes: ['communication'],
    }),
  },
};
