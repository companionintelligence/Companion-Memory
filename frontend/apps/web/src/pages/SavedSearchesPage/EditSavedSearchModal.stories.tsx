import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { DropdownProvider } from '@/components/SearchBox/useDropdown';

import { mockSavedSearch, withApollo } from './_storyHelpers';
import { EditSavedSearchModal } from './EditSavedSearchModal';

const meta: Meta<typeof EditSavedSearchModal> = {
  title: 'Saved Search/Edit Modal',
  component: EditSavedSearchModal,
  parameters: { layout: 'fullscreen' },
  decorators: [
    withApollo,
    (Story) => (
      <DropdownProvider args={[{ changeSearchParams: false }]}>
        <Story />
      </DropdownProvider>
    ),
  ],
  args: { onClose: fn() },
};

export default meta;

type Story = StoryObj<typeof EditSavedSearchModal>;

// Shows the new editable Filters section (who / where / when / how / sort / semantic)
// alongside name / description / query / entity types / tags.
export const WithFilters: Story = {
  args: { savedSearch: mockSavedSearch() },
};
