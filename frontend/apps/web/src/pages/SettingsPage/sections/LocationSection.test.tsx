import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocationSection } from './LocationSection';

const h = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'when_in_use' | 'always',
  setMode: vi.fn(),
  needsSettingsUpgrade: false,
  isNativePlatform: vi.fn(() => false),
  isIosPlatform: vi.fn(() => false),
  fetchJson: vi.fn(),
  openNativeLocationSettings: vi.fn(),
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'token', authenticated: true }, {}],
  useLocationTracking: () => ({
    mode: h.mode,
    setMode: h.setMode,
    needsSettingsUpgrade: h.needsSettingsUpgrade,
  }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
  isNativePlatform: h.isNativePlatform,
  isIosPlatform: h.isIosPlatform,
  openNativeLocationSettings: h.openNativeLocationSettings,
}));

beforeEach(() => {
  h.mode = 'off';
  h.needsSettingsUpgrade = false;
  h.setMode.mockReset();
  h.isNativePlatform.mockReset();
  h.isNativePlatform.mockReturnValue(false);
  h.isIosPlatform.mockReset();
  h.isIosPlatform.mockReturnValue(false);
  h.fetchJson.mockReset();
  h.fetchJson.mockResolvedValue({ total: 0, byProvider: {}, lastFixAt: null });
  h.openNativeLocationSettings.mockReset();
});

describe('LocationSection', () => {
  it('offers Off and While using on web, not Always', async () => {
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    expect(screen.getByRole('radio', { name: 'Off' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'While using' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Always' })).not.toBeInTheDocument();
    expect(screen.getByText(/Background location is on the mobile app/)).toBeInTheDocument();
  });

  it('offers Always on native (iOS or Android)', async () => {
    h.isNativePlatform.mockReturnValue(true);
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    expect(screen.getByRole('radio', { name: 'Always' })).toBeInTheDocument();
    expect(screen.queryByText(/Background location is on the mobile app/)).not.toBeInTheDocument();
  });

  it('shows the While using disclosure with Agree before enabling', async () => {
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('radio', { name: 'While using' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/Record your location while using Companion/)).toBeInTheDocument();
    expect(h.setMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Agree' }));

    expect(h.setMode).toHaveBeenCalledWith('when_in_use');
  });

  it('shows the Always disclosure on iPhone and requires Agree', async () => {
    h.isNativePlatform.mockReturnValue(true);
    h.isIosPlatform.mockReturnValue(true);
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('radio', { name: 'Always' }));

    expect(screen.getByText(/Remember places in the background/)).toBeInTheDocument();
    expect(screen.getByText(/no solid blue location indicator/)).toBeInTheDocument();
    expect(screen.getByText(/iOS asks twice/)).toBeInTheDocument();
    expect(h.setMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Agree' }));

    expect(h.setMode).toHaveBeenCalledWith('always');
  });

  it('shows Android the disclosure Play asks for, without the iPhone steps, and requires Agree', async () => {
    h.isNativePlatform.mockReturnValue(true);
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('radio', { name: 'Always' }));

    const dialog = screen.getByRole('alertdialog');

    expect(dialog).toHaveTextContent(/Remember places in the background/);
    expect(dialog).toHaveTextContent(
      'Companion collects location data to place your notes, photos and events on your map, even when the app is closed or not in use.',
    );
    expect(dialog).toHaveTextContent(/Android shows a notification that Companion is using your location/);
    expect(dialog).toHaveTextContent(/never used for ads/);
    expect(dialog).not.toHaveTextContent(/iPhone|iOS/);
    expect(h.setMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(h.setMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: 'Always' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agree' }));

    expect(h.setMode).toHaveBeenCalledWith('always');
  });

  it('turns off without a disclosure', async () => {
    h.mode = 'when_in_use';
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));

    expect(h.setMode).toHaveBeenCalledWith('off');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('offers Open Settings when Always was requested but the OS did not grant background access', async () => {
    h.isNativePlatform.mockReturnValue(true);
    h.mode = 'when_in_use';
    h.needsSettingsUpgrade = true;
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));

    expect(h.openNativeLocationSettings).toHaveBeenCalledTimes(1);
  });
});
