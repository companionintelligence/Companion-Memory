import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppLockStoreForTests } from '@/hooks/useAppLock';

import { AppLockSection } from './AppLockSection';

const mocks = vi.hoisted(() => ({
  native: true,
  android: true,
  plugin: {
    getStatus: vi.fn(),
    configure: vi.fn(),
    lock: vi.fn(),
    unlock: vi.fn(),
    setLockScreenNote: vi.fn(),
    addListener: vi.fn(),
  },
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => mocks.native,
  isAndroidPlatform: () => mocks.android,
  appLockPlugin: () => (mocks.native ? mocks.plugin : undefined),
}));

const base = {
  enabled: false,
  grace: '30s' as const,
  secureScreen: true,
  locked: false,
  available: true,
  biometry: 'strong' as const,
};

beforeEach(() => {
  resetAppLockStoreForTests();
  mocks.native = true;
  mocks.android = true;
  mocks.plugin.getStatus.mockReset().mockResolvedValue(base);
  mocks.plugin.configure.mockReset();
  mocks.plugin.lock.mockReset().mockResolvedValue({ ...base, enabled: true, locked: true });
  mocks.plugin.addListener.mockReset().mockResolvedValue({ remove: vi.fn() });
});

afterEach(() => resetAppLockStoreForTests());

describe('AppLockSection', () => {
  it('turning the lock on asks the plugin, which runs the prompt first', async () => {
    mocks.plugin.configure.mockResolvedValue({ ...base, enabled: true });
    render(<AppLockSection />);

    const toggle = await screen.findByRole('switch', { name: 'Require unlock' });

    fireEvent.click(toggle);

    expect(mocks.plugin.configure).toHaveBeenCalledWith({ enabled: true });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Require unlock' })).toBeChecked());
    // The grace picker and Lock now come alive with it.
    expect(screen.getByRole('button', { name: 'Lock now' })).toBeEnabled();
  });

  it('a cancelled prompt leaves the lock off and says so', async () => {
    mocks.plugin.configure.mockResolvedValue({ ...base, enabled: false, reason: 'authentication-cancelled' });
    render(<AppLockSection />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Require unlock' }));

    await waitFor(() => expect(screen.getByText(/the unlock check was cancelled/i)).toBeInTheDocument());
    expect(screen.getByRole('switch', { name: 'Require unlock' })).not.toBeChecked();
  });

  it('a device with nothing to unlock with cannot turn the lock on, and is told why', async () => {
    mocks.plugin.getStatus.mockResolvedValue({
      ...base,
      available: false,
      biometry: 'none',
      reason: 'No screen lock is set up on this device.',
    });
    render(<AppLockSection />);

    expect(await screen.findByText('No screen lock is set up on this device.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Require unlock' })).toBeDisabled();
  });

  it('Lock now engages the lock', async () => {
    mocks.plugin.getStatus.mockResolvedValue({ ...base, enabled: true });
    render(<AppLockSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Lock now' }));

    expect(mocks.plugin.lock).toHaveBeenCalledTimes(1);
  });

  it('on the web, explains the lock lives in the apps', () => {
    mocks.native = false;

    render(<AppLockSection />);

    expect(screen.getByText(/available in the iOS and Android apps/)).toBeInTheDocument();
    expect(mocks.plugin.getStatus).not.toHaveBeenCalled();
  });
});
