/**
 * The Safari card on the Devices path.
 *
 * The Memory app for iOS contains a Safari Web Extension of its own, and
 * Settings → Safari documents how to switch it on. The browser-extension gallery
 * nevertheless showed Safari as an inert "Coming soon" card on that very phone:
 * the one place the extension already exists was the one place the page said it
 * did not.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ ios: false }));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return { ...actual, isIosPlatform: () => h.ios };
});

vi.mock('./useDevices', () => ({ useDevices: () => ({ devices: [], loading: false }) }));

import { DevicesPanel } from './DevicesPanel';

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/sources/devices']}>
      <Routes>
        <Route path="/sources/devices" element={<DevicesPanel />} />
        <Route path="/settings/safari" element={<div>safari settings</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.ios = false;
});

describe('DevicesPanel Safari card', () => {
  it('is an inert coming-soon card wherever the extension is not bundled', () => {
    renderPanel();

    const safari = screen.getByRole('button', { name: /Safari/ });

    expect(safari).toBeDisabled();
    expect(safari).toHaveTextContent(/Coming soon/);
  });

  it('is not coming soon in the iOS app, which contains the extension', () => {
    h.ios = true;
    renderPanel();

    const safari = screen.getByRole('button', { name: /Safari/ });

    expect(safari).not.toBeDisabled();
    expect(safari).not.toHaveTextContent(/Coming soon/);
  });

  it('takes you to the steps that turn the bundled extension on', () => {
    h.ios = true;
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Safari/ }));

    expect(screen.getByText('safari settings')).toBeInTheDocument();
  });

  it('leaves the other browsers alone', () => {
    h.ios = true;
    renderPanel();

    expect(screen.getByRole('button', { name: /Chrome/ })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Firefox/ })).not.toBeDisabled();
  });
});
