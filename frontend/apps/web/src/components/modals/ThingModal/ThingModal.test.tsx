import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { CREATE_THING, ThingModal, type ThingModalItem } from './ThingModal';

const CAMERA: ThingModalItem = {
  id: 'item-1',
  name: 'Camera bag',
  brand: 'Domke',
  // Stored canonically: 12 in, 2.5 lb, entered by someone working in inches.
  lengthMm: 304.8,
  widthMm: 203.2,
  massG: 1133.981,
  unitSystem: 'IMPERIAL',
  colors: ['navy'],
  colorHex: '#123abc',
  materials: ['canvas', 'leather'],
  acquiredAt: '2024-03-02T00:00:00.000Z',
  acquisitionMethod: 'GIFT',
};

describe('ThingModal', () => {
  it('shows stored measurements back in the unit they were entered in', () => {
    renderWithProviders(<ThingModal open onClose={vi.fn()} item={CAMERA} create={false} />);

    // 304.8 mm is 12 in — the number the owner actually typed, not the one the
    // database holds.
    expect(screen.getByLabelText('Length (in)')).toHaveValue(12);
    expect(screen.getByLabelText('Width (in)')).toHaveValue(8);
    expect(screen.getByLabelText('Weight (lb)')).toHaveValue(2.5);
    expect(screen.getByLabelText('Colours')).toHaveValue('navy');
    expect(screen.getByLabelText('Made of')).toHaveValue('canvas, leather');
    expect(screen.getByLabelText('Acquired')).toHaveValue('2024-03-02');
  });

  it('re-labels and re-scales the measurements when the unit system changes', async () => {
    // Radix's Select is not keyboard/pointer-drivable under jsdom (no
    // PointerEvent), so the change is driven through the form's own state by
    // re-rendering the same item as metric — the conversion under test is the
    // same one either path runs.
    const { rerender } = renderWithProviders(
      <ThingModal open onClose={vi.fn()} item={CAMERA} create={false} />,
    );

    rerender(
      <ThingModal
        open
        onClose={vi.fn()}
        item={{ ...CAMERA, id: 'item-2', unitSystem: 'METRIC' }}
        create={false}
      />,
    );

    // The stored value never moved; only the way it is shown did.
    expect(await screen.findByLabelText('Length (cm)')).toHaveValue(30.48);
    expect(screen.getByLabelText('Weight (kg)')).toHaveValue(1.134);
  });

  it('offers the physical vocabulary a thing has, not just its name and price', () => {
    renderWithProviders(<ThingModal open onClose={vi.fn()} item={null} create />);

    for (const label of ['Name', 'Length (cm)', 'Weight (kg)', 'Capacity (L)', 'Colours', 'Made of']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }

    expect(screen.getByText('Physical')).toBeInTheDocument();
    expect(screen.getByText('Ownership')).toBeInTheDocument();
    expect(screen.getByText('Lifetime')).toBeInTheDocument();
  });

  it('will not submit an unnamed item', () => {
    renderWithProviders(<ThingModal open onClose={vi.fn()} item={null} create />);

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('converts what was typed into the canonical SI the API stores', async () => {
    const onClose = vi.fn();

    // The exact variables the form must send for '9 cm' and '0.35 kg'. The mock
    // only matches if the conversion is right, so a wrong factor fails here
    // rather than silently storing 9 millimetres.
    const created = mockQuery(
      CREATE_THING,
      {
        input: {
          name: 'Mug',
          category: null,
          description: null,
          brand: null,
          model: null,
          currentValue: null,
          purchasePrice: null,
          condition: null,
          acquiredAt: null,
          acquisitionMethod: null,
          acquiredFrom: null,
          manufacturedAt: null,
          expiresAt: null,
          colors: ['White', 'Cobalt'],
          colorHex: null,
          materials: null,
          unitSystem: 'METRIC',
          lengthMm: 90,
          widthMm: null,
          heightMm: null,
          massG: 350,
          volumeMl: null,
          quantity: null,
        },
      },
      {
        createItem: {
          __typename: 'CreateItemPayload',
          success: true,
          item: {
            __typename: 'ItemType',
            id: 'item-9',
            name: 'Mug',
            category: null,
            description: null,
            brand: null,
            model: null,
            currentValue: null,
            purchasePrice: null,
            condition: null,
            lifecycleState: 'ACTIVE' as const,
            quantity: 1,
            acquiredAt: null,
            acquisitionMethod: null,
            acquiredFrom: null,
            manufacturedAt: null,
            expiresAt: null,
            lengthMm: 90,
            widthMm: null,
            heightMm: null,
            massG: 350,
            volumeMl: null,
            unitSystem: 'METRIC',
            colors: ['white', 'cobalt'],
            colorHex: null,
            materials: null,
            composition: {},
            tags: [],
          },
        },
      },
    );

    renderWithProviders(<ThingModal open onClose={onClose} item={null} create />, {
      mocks: [created],
    });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mug' } });
    fireEvent.change(screen.getByLabelText('Length (cm)'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '0.35' } });
    fireEvent.change(screen.getByLabelText('Colours'), { target: { value: 'White, Cobalt' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('surfaces a rejected save instead of closing over it', async () => {
    const onClose = vi.fn();

    // No matching mock, so the mutation errors — which is what the server does
    // for an impossible measurement, and the dialog must keep the user's input.
    renderWithProviders(<ThingModal open onClose={onClose} item={null} create />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveValue('Mug');
  });
});
