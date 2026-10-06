import type { MockedResponse } from '@apollo/client/testing';
import { DeviceLocationError } from '@ci/common';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { CurrentLocationField } from './CurrentLocationField';
import { emptyPlaceDraft, type PlaceDraft } from './placeDraft';

const location = vi.hoisted(() => ({
  getCurrentDeviceLocation: vi.fn(),
  openNativeAppSettings: vi.fn(),
  isIosPlatform: vi.fn(() => true),
}));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    getCurrentDeviceLocation: location.getCurrentDeviceLocation,
    openNativeAppSettings: location.openNativeAppSettings,
    isIosPlatform: location.isIosPlatform,
  };
});

vi.mock('@/components/Map', () => ({
  Map: Object.assign(
    ({ children }: { children?: React.ReactNode }) => <div data-testid="place-preview-map">{children}</div>,
    { Marker: () => <div data-testid="place-preview-pin" /> },
  ),
}));

const REVERSE_GEOCODE = gql(`
  query ReverseGeocode($latitude: Float!, $longitude: Float!) {
    reverseGeocode(latitude: $latitude, longitude: $longitude) {
      status
      placeName
    }
  }
`);

const FIX = { latitude: 37.7823456, longitude: -122.4076123, accuracy: 8 };

function reverseMock(placeName: string | null, status = 'OK'): MockedResponse {
  return {
    request: {
      query: REVERSE_GEOCODE,
      variables: { latitude: FIX.latitude, longitude: FIX.longitude },
    },
    result: {
      data: {
        reverseGeocode: { __typename: 'ReverseGeocodeResultType', status, placeName },
      },
    },
  };
}

function renderField(
  draft: PlaceDraft = emptyPlaceDraft(),
  mocks: MockedResponse[] = [reverseMock('66 Mint St')],
) {
  const onChange = vi.fn();

  renderWithProviders(<CurrentLocationField value={draft} onChange={onChange} />, { mocks });

  return { onChange };
}

describe('CurrentLocationField', () => {
  it('drops an exact pin and fills the address from reverse geocode', async () => {
    location.getCurrentDeviceLocation.mockResolvedValue(FIX);
    const { onChange } = renderField();

    fireEvent.click(screen.getByRole('button', { name: /use my location/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toMatchObject({
      name: '',
      address: '66 Mint St',
      placeKind: '',
      latitude: '37.7823456',
      longitude: '-122.4076123',
    });
  });

  it('still pins when reverse geocode has no name', async () => {
    location.getCurrentDeviceLocation.mockResolvedValue(FIX);
    const { onChange } = renderField(emptyPlaceDraft(), [reverseMock(null, 'ZERO_RESULTS')]);

    fireEvent.click(screen.getByRole('button', { name: /use my location/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toMatchObject({
      name: 'Current location',
      latitude: '37.7823456',
      longitude: '-122.4076123',
    });
  });

  it('shows iOS Settings when location is denied', async () => {
    location.getCurrentDeviceLocation.mockRejectedValue(
      new DeviceLocationError('Location permission was denied', 'denied'),
    );
    renderField();

    fireEvent.click(screen.getByRole('button', { name: /use my location/i }));

    expect(await screen.findByText(/needs location access/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open ios settings/i }));
    expect(location.openNativeAppSettings).toHaveBeenCalledTimes(1);
  });
});
