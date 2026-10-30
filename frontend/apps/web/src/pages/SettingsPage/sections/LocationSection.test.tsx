import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocationSection } from './LocationSection';

const h = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'when_in_use' | 'always',
  setMode: vi.fn(),
  needsSettingsUpgrade: false,
  isNativePlatform: vi.fn(() => false),
  isIosPlatform: vi.fn(() => false),
  isAndroidPlatform: vi.fn(() => false),
  fetchJson: vi.fn(),
  openNativeLocationSettings: vi.fn(),
  pendingByKind: {} as Record<string, number>,
  getBackgroundUpload: vi.fn(),
  setBackgroundUpload: vi.fn(),
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
  isAndroidPlatform: h.isAndroidPlatform,
  openNativeLocationSettings: h.openNativeLocationSettings,
  useOutboxQueue: () => ({ pendingByKind: h.pendingByKind }),
  getBackgroundUpload: h.getBackgroundUpload,
  setBackgroundUpload: h.setBackgroundUpload,
}));

beforeEach(() => {
  h.mode = 'off';
  h.needsSettingsUpgrade = false;
  h.setMode.mockReset();
  h.isNativePlatform.mockReset();
  h.isNativePlatform.mockReturnValue(false);
  h.isIosPlatform.mockReset();
  h.isIosPlatform.mockReturnValue(false);
  h.isAndroidPlatform.mockReset();
  h.isAndroidPlatform.mockReturnValue(false);
  h.fetchJson.mockReset();
  h.fetchJson.mockResolvedValue({ total: 0, byProvider: {}, lastFixAt: null });
  h.openNativeLocationSettings.mockReset();
  h.pendingByKind = {};
  h.getBackgroundUpload.mockReset();
  h.getBackgroundUpload.mockResolvedValue({ enabled: false, supported: false });
  h.setBackgroundUpload.mockReset();
  h.setBackgroundUpload.mockImplementation(async (enabled: boolean) => ({ enabled, supported: true }));
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
    expect(screen.getByText(/Use your location while using Companion/)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Nothing is recorded in the background/);
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
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(/Android/);
    expect(h.setMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Agree' }));

    expect(h.setMode).toHaveBeenCalledWith('always');
  });

  it('shows Android the disclosure Play asks for, without the iPhone steps, and requires Agree', async () => {
    h.isNativePlatform.mockReturnValue(true);
    h.isAndroidPlatform.mockReturnValue(true);
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('radio', { name: 'Always' }));

    const dialog = screen.getByRole('alertdialog');

    expect(dialog).toHaveTextContent(/Remember places in the background/);
    // Play's required shape: location data, the feature it serves, and that collection goes
    // on when the app is closed or not in use.
    expect(dialog).toHaveTextContent(
      'Companion collects location data to place your notes, photos and events on your map, even when the app is closed or not in use.',
    );
    expect(dialog).toHaveTextContent(/only while you are on the move/);
    expect(dialog).toHaveTextContent(/A notification shows while that is happening/);
    expect(dialog).toHaveTextContent(/Allow all the time/);
    expect(dialog).toHaveTextContent(/never used for ads/);
    expect(dialog).not.toHaveTextContent(/iPhone|iOS/);
    // Background sampling needs no "Physical activity" grant; the copy must not suggest one.
    expect(dialog).not.toHaveTextContent(/physical activity/i);
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

  it('shows fixes still waiting in the outbox beside the uploaded count', async () => {
    h.pendingByKind = { positions: 80, note: 2 };
    h.fetchJson.mockResolvedValue({ total: 1, byProvider: { 'companion-mobile': 1 }, lastFixAt: null });
    render(<LocationSection />);

    expect(await screen.findByText('1 fixes recorded from your devices')).toBeInTheDocument();
    expect(screen.getByText(/80 more on this device, waiting to upload/)).toBeInTheDocument();
  });

  it('says nothing about waiting fixes when none are queued', async () => {
    h.pendingByKind = { note: 2 };
    render(<LocationSection />);
    await waitFor(() => expect(h.fetchJson).toHaveBeenCalled());

    expect(screen.queryByText(/waiting to upload/)).not.toBeInTheDocument();
  });

  it('recounts once waiting fixes upload', async () => {
    h.pendingByKind = { positions: 80 };
    h.fetchJson.mockResolvedValue({ total: 1, byProvider: { 'companion-mobile': 1 }, lastFixAt: null });
    const { rerender } = render(<LocationSection />);
    expect(await screen.findByText('1 fixes recorded from your devices')).toBeInTheDocument();

    h.fetchJson.mockResolvedValue({ total: 81, byProvider: { 'companion-mobile': 81 }, lastFixAt: null });
    h.pendingByKind = {};
    rerender(<LocationSection />);

    expect(await screen.findByText('81 fixes recorded from your devices')).toBeInTheDocument();
    expect(screen.queryByText(/waiting to upload/)).not.toBeInTheDocument();
  });

  it('offers background upload in Always where the phone supports it, on by default', async () => {
    h.mode = 'always';
    h.isNativePlatform.mockReturnValue(true);
    h.isAndroidPlatform.mockReturnValue(true);
    h.getBackgroundUpload.mockResolvedValue({ enabled: true, supported: true });
    render(<LocationSection />);

    const toggle = await screen.findByRole('switch', { name: 'Upload in the background' });
    expect(toggle).toBeChecked();
  });

  it('turns background upload off through the plugin', async () => {
    h.mode = 'always';
    h.isNativePlatform.mockReturnValue(true);
    h.getBackgroundUpload.mockResolvedValue({ enabled: true, supported: true });
    render(<LocationSection />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Upload in the background' }));

    expect(h.setBackgroundUpload).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Upload in the background' })).not.toBeChecked(),
    );
  });

  it('hides background upload where the phone has no uploader', async () => {
    h.mode = 'always';
    h.isNativePlatform.mockReturnValue(true);
    render(<LocationSection />);
    await waitFor(() => expect(h.getBackgroundUpload).toHaveBeenCalled());

    expect(screen.queryByRole('switch', { name: 'Upload in the background' })).not.toBeInTheDocument();
  });

  it('hides background upload outside Always, where nothing records in the background', async () => {
    h.mode = 'when_in_use';
    h.isNativePlatform.mockReturnValue(true);
    h.getBackgroundUpload.mockResolvedValue({ enabled: true, supported: true });
    render(<LocationSection />);
    await waitFor(() => expect(h.getBackgroundUpload).toHaveBeenCalled());

    expect(screen.queryByRole('switch', { name: 'Upload in the background' })).not.toBeInTheDocument();
  });

  it('says waiting fixes upload in the background when that is on', async () => {
    h.mode = 'always';
    h.isNativePlatform.mockReturnValue(true);
    h.getBackgroundUpload.mockResolvedValue({ enabled: true, supported: true });
    h.pendingByKind = { positions: 3 };
    render(<LocationSection />);

    expect(await screen.findByText(/upload in the background once this phone can reach/)).toBeInTheDocument();
  });
});
