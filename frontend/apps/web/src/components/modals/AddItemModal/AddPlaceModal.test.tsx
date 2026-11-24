/**
 * AddPlaceModal: the hand-made path into ci.entities Locations. The mutation is
 * stubbed, so this suite covers the modal's own wiring — what a blank kind and
 * a half-typed coordinate do, and that coordinates go out as typed top-level
 * fields (the resolver writes them to location_point) rather than properties.
 */
import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { AddPlaceModal } from './AddPlaceModal';

const CREATE_PLACE = gql(`
  mutation CreatePlace($input: CreatePlaceInput!) {
    createPlace(input: $input) {
      id
      name
      description
      placeKind
      latitude
      longitude
    }
  }
`);

function renderModal(mocks: MockedResponse[] = []) {
  const onClose = vi.fn();
  const onCreated = vi.fn();

  renderWithProviders(<AddPlaceModal open onClose={onClose} onCreated={onCreated} />, { mocks });

  return { onClose, onCreated };
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function createMock(capture: (input: Record<string, unknown>) => void): MockedResponse {
  return {
    request: {
      query: CREATE_PLACE,
      variables: (variables: { input: Record<string, unknown> }) => {
        capture(variables.input);

        return true;
      },
    },
    result: {
      data: {
        createPlace: {
          __typename: 'PlaceType',
          id: 'place-1',
          name: 'Blue Bottle',
          description: null,
          placeKind: null,
          latitude: null,
          longitude: null,
        },
      },
    },
  } as unknown as MockedResponse;
}

describe('AddPlaceModal — validation', () => {
  it('refuses an unnamed place without calling the mutation', async () => {
    const sent = vi.fn();
    const { onClose } = renderModal([createMock(sent)]);

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findByText(/give the place a name/i)).toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses half a coordinate pair rather than dropping it silently', async () => {
    const sent = vi.fn();
    renderModal([createMock(sent)]);

    fill(/^name$/i, 'Blue Bottle');
    fill(/^longitude$/i, '-122.4076');

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findByText(/both a latitude/i)).toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('AddPlaceModal — creating the place', () => {
  it('sends coordinates as top-level fields and the address on properties, then closes', async () => {
    const inputs: Record<string, unknown>[] = [];
    const { onClose, onCreated } = renderModal([createMock((input) => inputs.push(input))]);

    fill(/^name$/i, 'Blue Bottle');
    fill(/^address$/i, '66 Mint St');
    fill(/^latitude$/i, '37.7823');
    fill(/^longitude$/i, '-122.4076');

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));

    expect(inputs[0]).toMatchObject({
      name: 'Blue Bottle',
      latitude: 37.7823,
      longitude: -122.4076,
      properties: { address: '66 Mint St' },
    });
    // Never '' — the resolver rejects any kind outside its closed set.
    expect(inputs[0].placeKind).toBeUndefined();
  });

  it('keeps the draft and shows the error when the write is rejected', async () => {
    const { onClose, onCreated } = renderModal([
      {
        request: { query: CREATE_PLACE, variables: () => true },
        error: new Error('network down'),
      } as unknown as MockedResponse,
    ]);

    fill(/^name$/i, 'Blue Bottle');
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/network down/i);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Blue Bottle');
  });
});
