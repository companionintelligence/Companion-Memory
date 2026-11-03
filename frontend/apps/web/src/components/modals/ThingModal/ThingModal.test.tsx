import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { CREATE_THING, ThingModal, UPDATE_THING, type ThingModalItem } from './ThingModal';

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

/**
 * Acquired, Made and Expires are days, stored as instants. A picked 2026-10-01
 * is stored as UTC midnight and read back as the day it names in every zone
 * (`lib/thingDate`). The start of the picked day where the person was named the
 * day before to anyone further west: Oct 1 picked in Tokyo read as Sep 30 in
 * Los Angeles, and the server's daily stats counted it on Sep 30.
 */
describe('ThingModal dates', () => {
  const ORIGINAL_TZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  });

  const input = {
    name: 'Grinder',
    category: null,
    description: null,
    brand: null,
    model: null,
    currentValue: null,
    purchasePrice: null,
    condition: null,
    acquisitionMethod: null,
    acquiredFrom: null,
    manufacturedAt: null,
    expiresAt: null,
    colors: null,
    colorHex: null,
    materials: null,
    unitSystem: 'METRIC' as const,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    massG: null,
    volumeMl: null,
    quantity: null,
  };

  it.each(['America/Los_Angeles', 'Asia/Tokyo'])(
    'sends the picked day as UTC midnight in %s',
    async (zone) => {
      process.env.TZ = zone;
      const onClose = vi.fn();
      // Not the start of Oct 1 where the person is (07:00Z from Los Angeles, 15:00Z on
      // Sep 30 from Tokyo), which every other zone reads as a different day.
      const acquiredAt = '2026-10-01T00:00:00.000Z';
      const created = mockQuery(
        CREATE_THING,
        { input: { ...input, acquiredAt } },
        {
          createItem: {
            __typename: 'CreateItemPayload',
            success: true,
            item: {
              __typename: 'ItemType',
              id: 'item-10',
              ...input,
              acquiredAt,
              lifecycleState: 'ACTIVE' as const,
              quantity: 1,
              colors: [],
              composition: {},
              tags: [],
            },
          },
        },
      );

      renderWithProviders(<ThingModal open onClose={onClose} item={null} create />, { mocks: [created] });

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Grinder' } });
      fireEvent.change(screen.getByLabelText('Acquired'), { target: { value: '2026-10-01' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
    },
  );

  it('keeps a date nobody touched as stored when something else is edited', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const onClose = vi.fn();
    const saved: Array<Record<string, unknown>> = [];
    // An importer's order time (8 pm on Sep 30 in Los Angeles) and a day the form picked.
    const item = { ...CAMERA, acquiredAt: '2026-10-01T03:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' };

    renderWithProviders(<ThingModal open onClose={onClose} item={item} create={false} />, {
      mocks: [
        {
          request: { query: UPDATE_THING },
          variableMatcher: () => true,
          result: (variables: Record<string, unknown>) => {
            saved.push(variables.input as Record<string, unknown>);

            return { data: { updateItem: { __typename: 'UpdateItemPayload', success: true, item: null } } };
          },
        },
      ],
    });

    fireEvent.change(screen.getByLabelText('Brand'), { target: { value: 'Billingham' } });
    fireEvent.change(screen.getByLabelText('Made'), { target: { value: '2023-05-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual(
      expect.objectContaining({
        brand: 'Billingham',
        // Not cut to 2026-09-30T00:00:00.000Z, the day the input shows here.
        acquiredAt: '2026-10-01T03:00:00.000Z',
        manufacturedAt: '2023-05-04T00:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    );
  });

  it('shows a stored date on the same day the thing page shows it', () => {
    process.env.TZ = 'America/Los_Angeles';

    // An importer's order time: 8 pm on Sep 30 in Los Angeles, already Oct 1 in UTC.
    renderWithProviders(
      <ThingModal
        open
        onClose={vi.fn()}
        item={{ ...CAMERA, acquiredAt: '2026-10-01T03:00:00.000Z' }}
        create={false}
      />,
    );

    expect(screen.getByLabelText('Acquired')).toHaveValue('2026-09-30');
  });

  // CI runs in UTC, where a UTC midnight and a local midnight are the same
  // instant, so the zone is chosen here rather than inherited.
  it.each(['UTC', 'Pacific/Honolulu', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati'])(
    'shows the day a UTC-midnight date names in %s',
    (zone) => {
      process.env.TZ = zone;

      // What the form stores: the picked day as UTC midnight. West of UTC that
      // instant is still the day before.
      renderWithProviders(
        <ThingModal
          open
          onClose={vi.fn()}
          item={{
            ...CAMERA,
            acquiredAt: '2024-03-02T00:00:00.000Z',
            manufacturedAt: '2023-12-31T00:00:00.000Z',
            expiresAt: '2030-01-01T00:00:00.000Z',
          }}
          create={false}
        />,
      );

      expect(screen.getByLabelText('Acquired')).toHaveValue('2024-03-02');
      expect(screen.getByLabelText('Made')).toHaveValue('2023-12-31');
      expect(screen.getByLabelText('Expires')).toHaveValue('2030-01-01');
    },
  );

  it.each(['UTC', 'Pacific/Honolulu', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati'])(
    'shows the day a start-of-local-day date names in %s',
    (zone) => {
      process.env.TZ = zone;

      // What the form stored for a while: midnight where the person was.
      renderWithProviders(
        <ThingModal
          open
          onClose={vi.fn()}
          item={{ ...CAMERA, acquiredAt: new Date(2024, 2, 2).toISOString() }}
          create={false}
        />,
      );

      expect(screen.getByLabelText('Acquired')).toHaveValue('2024-03-02');
    },
  );
});
