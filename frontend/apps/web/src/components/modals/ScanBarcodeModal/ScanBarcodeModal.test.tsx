import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ObjectIdentifierNamespace } from '@/graphql/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { OBJECT_BY_IDENTIFIER, ScanBarcodeModal } from './ScanBarcodeModal';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const ITEM_ID = btoa('item:drill-1');

const lookupMock = (
  variables: { namespace: ObjectIdentifierNamespace; value: string },
  payload: {
    matched: boolean;
    item?: { id: string; name: string } | null;
    product?: { id: string; title: string } | null;
  },
) =>
  mockQuery(OBJECT_BY_IDENTIFIER, variables, {
    objectByIdentifier: {
      __typename: 'ObjectByIdentifierPayload' as const,
      matched: payload.matched,
      // The lookup normalizes on the way in, so the echoed namespace/value are
      // not necessarily the ones asked for.
      namespace: 'GTIN' as const,
      value: '0012345678905',
      subjectType: payload.item
        ? ('OBJECT_INSTANCE' as const)
        : payload.product
          ? ('PRODUCT_MODEL' as const)
          : null,
      confidence: payload.matched ? 1 : 0,
      item: payload.item
        ? {
            __typename: 'ItemType' as const,
            id: payload.item.id,
            name: payload.item.name,
            brand: 'Makita',
            model: 'XPH',
          }
        : null,
      product: payload.product
        ? {
            __typename: 'ProductModelType' as const,
            id: payload.product.id,
            title: payload.product.title,
            brand: 'Makita',
          }
        : null,
    },
  });

const type = (value: string) => {
  fireEvent.change(screen.getByLabelText('Code value'), { target: { value } });
};

describe('ScanBarcodeModal', () => {
  it('cannot look up an empty code', () => {
    renderWithProviders(<ScanBarcodeModal open onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled();

    type('  ');

    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled();
  });

  it('opens the thing that carries the code, decoding its global id for the route', async () => {
    const onClose = vi.fn();

    renderWithProviders(<ScanBarcodeModal open onClose={onClose} />, {
      mocks: [
        lookupMock(
          { namespace: 'GTIN', value: '012345678905' },
          { matched: true, item: { id: ITEM_ID, name: 'Cordless drill' } },
        ),
      ],
    });

    type('012345678905');
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/drill-1'));
    expect(onClose).toHaveBeenCalled();
  });

  it('trims the typed code before sending it — a scanner adds whitespace', async () => {
    renderWithProviders(<ScanBarcodeModal open onClose={vi.fn()} />, {
      mocks: [
        // Variable matching is the assertion: an untrimmed value misses it.
        lookupMock(
          { namespace: 'GTIN', value: '012345678905' },
          { matched: true, item: { id: ITEM_ID, name: 'Cordless drill' } },
        ),
      ],
    });

    type('  012345678905  ');
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/drill-1'));
  });

  it('submits on Enter, which is how a barcode scanner ends its input', async () => {
    renderWithProviders(<ScanBarcodeModal open onClose={vi.fn()} />, {
      mocks: [
        lookupMock(
          { namespace: 'GTIN', value: '012345678905' },
          { matched: true, item: { id: ITEM_ID, name: 'Cordless drill' } },
        ),
      ],
    });

    type('012345678905');
    fireEvent.keyDown(screen.getByLabelText('Code value'), { key: 'Enter' });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/drill-1'));
  });

  it('says the catalog knows the product but nothing owned claims the code, and does NOT navigate', async () => {
    navigate.mockClear();

    renderWithProviders(<ScanBarcodeModal open onClose={vi.fn()} />, {
      mocks: [
        lookupMock(
          { namespace: 'GTIN', value: '012345678905' },
          { matched: true, product: { id: btoa('product:p1'), title: 'Makita XPH drill' } },
        ),
      ],
    });

    type('012345678905');
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(
      await screen.findByText(/That code identifies "Makita XPH drill", a product model/),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reports a code that matches nothing rather than minting a row for it', async () => {
    navigate.mockClear();

    renderWithProviders(<ScanBarcodeModal open onClose={vi.fn()} />, {
      mocks: [lookupMock({ namespace: 'GTIN', value: 'nope' }, { matched: false })],
    });

    type('nope');
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('Nothing you own carries nope.')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('surfaces a failed lookup instead of looking like a no-match', async () => {
    renderWithProviders(<ScanBarcodeModal open onClose={vi.fn()} />, {
      mocks: [
        mockQuery(
          OBJECT_BY_IDENTIFIER,
          { namespace: 'GTIN', value: '012345678905' },
          { error: new Error('identity service unavailable') },
        ),
      ],
    });

    type('012345678905');
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('identity service unavailable')).toBeInTheDocument();
  });

  it('sends the chosen namespace, not always GTIN', async () => {
    renderWithProviders(<ScanBarcodeModal open onClose={vi.fn()} />, {
      mocks: [
        lookupMock(
          { namespace: 'SERIAL', value: 'SN-4471' },
          { matched: true, item: { id: ITEM_ID, name: 'Cordless drill' } },
        ),
      ],
    });

    fireEvent.click(screen.getByLabelText('Code type'));
    fireEvent.click(await screen.findByRole('option', { name: 'Serial number' }));

    type('SN-4471');
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/drill-1'));
  });
});
