import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import type { EditableFilters } from './savedSearchFiltersEdit';
import { SavedSearchFiltersEditor } from './SavedSearchFiltersEditor';

const meta: Meta<typeof SavedSearchFiltersEditor> = {
  title: 'Saved Search/Filters Editor',
  component: SavedSearchFiltersEditor,
  parameters: { layout: 'padded' },
};

export default meta;

type Story = StoryObj<typeof SavedSearchFiltersEditor>;

function Harness({ initial }: { initial: EditableFilters }) {
  const [value, setValue] = useState<EditableFilters>(initial);

  return (
    <div className="max-w-md">
      <SavedSearchFiltersEditor value={value} onChange={setValue} />
    </div>
  );
}

export const Populated: Story = {
  render: () => (
    <Harness
      initial={{
        people: ['Alex'],
        places: ['Paris'],
        eventTypes: ['visited'],
        connectors: ['google-photos'],
        startTime: '2024-06-01T00:00:00.000Z',
        endTime: '2024-06-30T23:59:59.999Z',
        sortBy: 'time',
        sortOrder: 'desc',
        hasLocation: true,
      }}
    />
  ),
};

export const Empty: Story = {
  render: () => <Harness initial={{}} />,
};
