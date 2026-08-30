import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import {
  ADD_ITEM_IDENTIFIER,
  MERGE_ITEMS,
  OBJECT_BY_IDENTIFIER,
  OBJECT_IDENTIFIER_FRAGMENT,
  ObjectIdentifierList,
  REMOVE_ITEM_IDENTIFIER,
} from './ObjectIdentifierList';

const ITEM_ID = 'aXRlbTphYmM=';
const OTHER_ITEM_ID = 'aXRlbTp4eXo=';

const makeIdentifier = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'ObjectIdentifierType' as const,
      namespace: 'GTIN' as const,
      value: '0012345678905',
      rawValue: '012345678905',
      qualifier: '',
      isPrimary: true,
      confidence: 1,
      source: 'user',
      ...overrides,
    },
    OBJECT_IDENTIFIER_FRAGMENT,
  );

/** The identifier list the mutations echo back. Masked, so shape is all that matters. */
const IDENTIFIER_PAYLOAD = [
  {
    __typename: 'ObjectIdentifierType' as const,
    namespace: 'GTIN' as const,
    value: '0012345678905',
    rawValue: '012345678905',
    qualifier: '',
    isPrimary: true,
    confidence: 1,
    source: 'user',
  },
];

describe('ObjectIdentifierList', () => {
  it('shows the printed code, and the normalized key when they differ', () => {
    renderWithProviders(<ObjectIdentifierList itemId={ITEM_ID} identifiers={[makeIdentifier()]} />);

    expect(screen.getByText('012345678905')).toBeInTheDocument();
    expect(screen.getByText('Normalized: 0012345678905')).toBeInTheDocument();
    // Twice: once as the row's badge, once as the add form's default selection.
    expect(screen.getAllByText('Barcode (GTIN)')).toHaveLength(2);
  });

  it('says so plainly when a thing carries no codes', () => {
    renderWithProviders(<ObjectIdentifierList itemId={ITEM_ID} identifiers={[]} />);

    expect(screen.getByText('No codes on this thing yet.')).toBeInTheDocument();
  });

  it('hides the add and remove affordances when read-only', () => {
    renderWithProviders(<ObjectIdentifierList itemId={ITEM_ID} identifiers={[makeIdentifier()]} readOnly />);

    expect(screen.queryByRole('button', { name: /add code/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('adds a code and asks its caller to refresh', async () => {
    const onChanged = vi.fn();

    renderWithProviders(<ObjectIdentifierList itemId={ITEM_ID} identifiers={[]} onChanged={onChanged} />, {
      mocks: [
        mockQuery(
          ADD_ITEM_IDENTIFIER,
          { input: { itemId: ITEM_ID, namespace: 'GTIN', value: '0012345678905' } },
          { addItemIdentifier: IDENTIFIER_PAYLOAD },
        ),
      ],
    });

    fireEvent.change(screen.getByLabelText('Code value'), { target: { value: '0012345678905' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('removes a code and asks its caller to refresh', async () => {
    const onChanged = vi.fn();

    renderWithProviders(
      <ObjectIdentifierList itemId={ITEM_ID} identifiers={[makeIdentifier()]} onChanged={onChanged} />,
      {
        mocks: [
          mockQuery(
            REMOVE_ITEM_IDENTIFIER,
            { input: { itemId: ITEM_ID, namespace: 'GTIN', value: '0012345678905' } },
            { removeItemIdentifier: [] },
          ),
        ],
      },
    );

    // The accessible name tracks the displayed (raw) value, not the normalized
    // matching key underneath it — see ObjectIdentifierList's `displayValue`.
    fireEvent.click(screen.getByRole('button', { name: 'Remove 012345678905' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('offers a merge, naming the other thing, when the code is already claimed', async () => {
    // The backend deliberately does NOT steal a claim (first-writer-wins), so
    // the refusal is a duplicate signal — not an error to apologise for.
    renderWithProviders(<ObjectIdentifierList itemId={ITEM_ID} identifiers={[]} />, {
      mocks: [
        mockQuery(
          ADD_ITEM_IDENTIFIER,
          { input: { itemId: ITEM_ID, namespace: 'GTIN', value: '0012345678905' } },
          {
            error: new Error(
              'That identifier already belongs to another thing. Merge the two things instead of re-assigning it.',
            ),
          },
        ),
        mockQuery(
          OBJECT_BY_IDENTIFIER,
          { namespace: 'GTIN', value: '0012345678905' },
          {
            objectByIdentifier: {
              __typename: 'ObjectByIdentifierPayload' as const,
              matched: true,
              namespace: 'GTIN' as const,
              value: '0012345678905',
              subjectType: 'OBJECT_INSTANCE' as const,
              confidence: 1,
              item: {
                __typename: 'ItemType' as const,
                id: OTHER_ITEM_ID,
                name: 'The other drill',
                brand: 'Makita',
                model: 'XPH',
              },
              product: null,
            },
          },
        ),
      ],
    });

    fireEvent.change(screen.getByLabelText('Code value'), { target: { value: '0012345678905' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));

    expect(await screen.findByText('The other drill')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge these things' })).toBeInTheDocument();
  });

  it('merges the two things once the merge is confirmed', async () => {
    const onChanged = vi.fn();

    renderWithProviders(<ObjectIdentifierList itemId={ITEM_ID} identifiers={[]} onChanged={onChanged} />, {
      mocks: [
        mockQuery(
          ADD_ITEM_IDENTIFIER,
          { input: { itemId: ITEM_ID, namespace: 'GTIN', value: '0012345678905' } },
          {
            error: new Error(
              'That identifier already belongs to another thing. Merge the two things instead of re-assigning it.',
            ),
          },
        ),
        mockQuery(
          OBJECT_BY_IDENTIFIER,
          { namespace: 'GTIN', value: '0012345678905' },
          {
            objectByIdentifier: {
              __typename: 'ObjectByIdentifierPayload' as const,
              matched: true,
              namespace: 'GTIN' as const,
              value: '0012345678905',
              subjectType: 'OBJECT_INSTANCE' as const,
              confidence: 1,
              item: {
                __typename: 'ItemType' as const,
                id: OTHER_ITEM_ID,
                name: 'The other drill',
                brand: null,
                model: null,
              },
              product: null,
            },
          },
        ),
        mockQuery(
          MERGE_ITEMS,
          { input: { targetId: ITEM_ID, sourceIds: [OTHER_ITEM_ID] } },
          {
            mergeItems: {
              __typename: 'MergeItemsPayload' as const,
              success: true,
              item: { __typename: 'ItemType' as const, id: ITEM_ID, name: 'This drill' },
            },
          },
        ),
      ],
    });

    fireEvent.change(screen.getByLabelText('Code value'), { target: { value: '0012345678905' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Merge these things' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into one thing' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('surfaces an ordinary failure as an error, not as a merge offer', async () => {
    renderWithProviders(<ObjectIdentifierList itemId={ITEM_ID} identifiers={[]} />, {
      mocks: [
        mockQuery(
          ADD_ITEM_IDENTIFIER,
          { input: { itemId: ITEM_ID, namespace: 'GTIN', value: 'nonsense' } },
          {
            error: new Error('"nonsense" does not normalize to a usable GTIN identifier'),
          },
        ),
      ],
    });

    fireEvent.change(screen.getByLabelText('Code value'), { target: { value: 'nonsense' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }));

    expect(await screen.findByText(/does not normalize to a usable GTIN/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge these things' })).toBeNull();
  });
});
