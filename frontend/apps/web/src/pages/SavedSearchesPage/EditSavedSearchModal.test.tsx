import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DropdownProvider } from '@/components/SearchBox/useDropdown';
import { renderWithProviders } from '@/test/renderWithProviders';

import { mockSavedSearch } from './_storyHelpers';
import { EditSavedSearchModal, UPDATE_SAVED_SEARCH } from './EditSavedSearchModal';

/**
 * `TagInput` used to be wired to nothing on this modal: `onTagAdded={() =>
 * true}` accepted every add into a void, there was no `onTagRemoved`, and
 * `handleSave` never selected `tags` on the mutation at all. The backend
 * writes `tags: this.assembleTags(data)` unconditionally, so saving ANY
 * change on this dialog — renaming it, editing the description — silently
 * wiped the search's tags. These prove the whole path end to end: the
 * existing tag renders, saving with no changes still sends the existing tag
 * (the acute regression — the field must not be omitted), and removing a
 * tag then saving sends the reduced list.
 */
function renderModal(onSave: (variables: Record<string, unknown>) => void) {
  return renderWithProviders(
    <DropdownProvider args={[{ changeSearchParams: false }]}>
      <EditSavedSearchModal savedSearch={mockSavedSearch()} onClose={() => {}} />
    </DropdownProvider>,
    {
      mocks: [
        {
          request: { query: UPDATE_SAVED_SEARCH },
          variableMatcher: () => true,
          result: (variables: Record<string, unknown>) => {
            onSave(variables);

            return {
              data: {
                updateSavedSearch: {
                  __typename: 'UpdateSavedSearchPayload',
                  success: true,
                  savedSearch: null,
                },
              },
            };
          },
        },
      ],
    },
  );
}

describe('EditSavedSearchModal — tags', () => {
  it('shows the saved search’s existing tag', async () => {
    renderModal(() => undefined);

    expect(await screen.findByText('travel')).toBeInTheDocument();
  });

  it('saving with no changes still sends the existing tags, not an omitted field', async () => {
    const saved: Record<string, unknown>[] = [];
    renderModal((variables) => saved.push(variables));

    await screen.findByText('travel');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const input = saved[0].input as Record<string, unknown>;
    expect(input.tags).toEqual(['travel']);
  });

  it('removing a tag then saving sends the reduced list', async () => {
    const saved: Record<string, unknown>[] = [];
    renderModal((variables) => saved.push(variables));

    await screen.findByText('travel');
    fireEvent.click(screen.getByRole('button', { name: /remove tag.*travel/i }));
    await waitFor(() => expect(screen.queryByText('travel')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const input = saved[0].input as Record<string, unknown>;
    expect(input.tags).toEqual([]);
  });
});
