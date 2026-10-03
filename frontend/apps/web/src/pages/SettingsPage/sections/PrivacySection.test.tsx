import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrivacySection } from './PrivacySection';

const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'token', authenticated: true }, {}],
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

const path = (key: string, over = {}) => ({
  key,
  enabled: true,
  effective: true,
  locked: false,
  lockedReason: null,
  ...over,
});

const settings = (canEdit: boolean, over: Record<string, object> = {}) => ({
  canEdit,
  paths: ['crash_reports', 'place_lookups', 'link_previews', 'portal_oauth'].map((k) => path(k, over[k])),
});

beforeEach(() => h.fetchJson.mockReset());

describe('PrivacySection', () => {
  it('lists every outbound path', async () => {
    h.fetchJson.mockResolvedValue(settings(true));
    render(<PrivacySection />);

    for (const name of ['Crash reports', 'Place lookups', 'Link previews', 'Sign-in through Portal']) {
      expect(await screen.findByRole('switch', { name })).toBeInTheDocument();
    }
  });

  it('PUTs the new value when a switch is flipped', async () => {
    h.fetchJson.mockResolvedValueOnce(settings(true));
    h.fetchJson.mockResolvedValueOnce(
      settings(true, { link_previews: { enabled: false, effective: false } }),
    );
    render(<PrivacySection />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Link previews' }));

    await waitFor(() =>
      expect(h.fetchJson).toHaveBeenLastCalledWith(
        '/api/privacy/outbound',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ key: 'link_previews', enabled: false }) }),
      ),
    );
  });

  it('disables the switches and says why for a non-admin', async () => {
    h.fetchJson.mockResolvedValue(settings(false));
    render(<PrivacySection />);

    expect(await screen.findByRole('switch', { name: 'Crash reports' })).toBeDisabled();
    expect(screen.getByText(/Only an administrator/)).toBeInTheDocument();
  });

  it('shows the operator lock reason', async () => {
    h.fetchJson.mockResolvedValue(
      settings(true, {
        crash_reports: { effective: false, locked: true, lockedReason: 'Set by whoever runs the appliance.' },
      }),
    );
    render(<PrivacySection />);

    expect(await screen.findByText('Set by whoever runs the appliance.')).toBeInTheDocument();
  });
});
