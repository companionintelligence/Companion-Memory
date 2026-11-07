import { gql as apolloGql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { DeleteTagModal } from './DeleteTagModal';
import { type TagListItem } from './tagList';

const DELETE_TAG = gql(`
  mutation DeleteTag($input: DeleteByIdInput!) {
    deleteTag(input: $input) {
      success
      deletedId
    }
  }
`);

/**
 * A minimal stand-in for the Memory explorer's own `tags` query. The modal
 * evicts the tag from the normalized cache rather than patching one list, so
 * any query holding the tag should lose it — this proves that on a query the
 * modal knows nothing about.
 */
const LIST_TAGS = apolloGql(`
  query ListTagsForTest {
    tags {
      edges {
        node {
          id
          label
        }
      }
    }
  }
`);

const tag = (overrides: Partial<TagListItem> = {}): TagListItem => ({
  id: 't1',
  label: 'holiday',
  description: null,
  entityCount: 3,
  ...overrides,
});

function listMock(nodes: Array<{ id: string; label: string }>) {
  return {
    request: { query: LIST_TAGS },
    result: {
      data: {
        tags: {
          __typename: 'TagConnection',
          edges: nodes.map((node) => ({
            __typename: 'TagEdge',
            node: { __typename: 'TagType', ...node },
          })),
        },
      },
    },
  };
}

function deleteMock(id: string, deletedId: string | null = id) {
  return {
    request: { query: DELETE_TAG, variables: { input: { id } } },
    result: {
      data: {
        deleteTag: { __typename: 'DeleteByIdPayload', success: Boolean(deletedId), deletedId },
      },
    },
  };
}

function ListAndModal(props: { onClose: () => void; onDeleted: () => void }) {
  const { data } = useQuery<{ tags: { edges: { node: { id: string; label: string } }[] } }>(LIST_TAGS);

  return (
    <>
      <ul data-testid="tag-list">
        {(data?.tags.edges ?? []).map((edge) => (
          <li key={edge.node.id}>{edge.node.label}</li>
        ))}
      </ul>
      <DeleteTagModal tag={tag()} {...props} />
    </>
  );
}

describe('DeleteTagModal', () => {
  it('says how many items lose the tag, and that they survive it', () => {
    renderWithProviders(<DeleteTagModal tag={tag()} onClose={vi.fn()} onDeleted={vi.fn()} />, { mocks: [] });

    expect(screen.getByText(/removed from 3 items/i)).toBeInTheDocument();
    expect(screen.getByText(/stay in your memory/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('does not promise items will change when nothing carries the tag', () => {
    renderWithProviders(
      <DeleteTagModal tag={tag({ entityCount: 0 })} onClose={vi.fn()} onDeleted={vi.fn()} />,
      { mocks: [] },
    );

    expect(screen.getByText(/nothing is tagged with it/i)).toBeInTheDocument();
  });

  it('cancels without sending a delete', () => {
    const onClose = vi.fn();
    const onDeleted = vi.fn();

    // No delete mock: a stray mutation would surface as an unmatched request.
    renderWithProviders(<DeleteTagModal tag={tag()} onClose={onClose} onDeleted={onDeleted} />, {
      mocks: [],
    });

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('deletes on confirm and drops the tag from an unrelated cached query', async () => {
    const onDeleted = vi.fn();

    renderWithProviders(<ListAndModal onClose={vi.fn()} onDeleted={onDeleted} />, {
      mocks: [
        listMock([
          { id: 't1', label: 'holiday' },
          { id: 't2', label: 'work' },
        ]),
        deleteMock('t1'),
      ],
    });

    const list = () => within(screen.getByTestId('tag-list'));

    await waitFor(() => expect(list().getByText('holiday')).toBeInTheDocument());
    expect(list().getByText('work')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete tag/i }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    // Evicted from the normalized cache, so a query the modal never named
    // loses the row while its siblings stay put.
    await waitFor(() => expect(list().queryByText('holiday')).not.toBeInTheDocument());
    expect(list().getByText('work')).toBeInTheDocument();
  });

  it('keeps the dialog open and explains itself when the delete fails', async () => {
    const onClose = vi.fn();
    const onDeleted = vi.fn();

    renderWithProviders(<DeleteTagModal tag={tag()} onClose={onClose} onDeleted={onDeleted} />, {
      mocks: [
        {
          request: { query: DELETE_TAG, variables: { input: { id: 't1' } } },
          error: new Error('network down'),
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /delete tag/i }));

    expect(await screen.findByText(/could not delete this tag/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
