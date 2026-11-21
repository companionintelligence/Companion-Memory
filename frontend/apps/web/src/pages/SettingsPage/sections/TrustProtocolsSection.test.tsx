import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TrustProtocolsSection } from './TrustProtocolsSection';

const h = vi.hoisted(() => ({
  enabledFlags: new Set<string>(['ask']),
  loading: false,
  refresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({
    isFeatureEnabled: (flag: string) => h.enabledFlags.has(flag),
    loading: h.loading,
    refresh: h.refresh,
  }),
}));

describe('TrustProtocolsSection', () => {
  beforeEach(() => {
    h.enabledFlags = new Set(['ask']);
    h.loading = false;
    h.refresh.mockClear();
  });

  it('splits the standards into what is on and what is off', () => {
    render(<TrustProtocolsSection />);

    expect(screen.getByText('Trust & protocols')).toBeInTheDocument();

    const on = screen.getByRole('region', { name: 'On (2)' });
    const off = screen.getByRole('region', { name: 'Off (7)' });

    expect(within(on).getByText('Companion Asks & Delegated Consent')).toBeInTheDocument();
    expect(within(on).getByText('Capability Attenuated API Keys & Field Crypto')).toBeInTheDocument();
    expect(within(off).getByText('Solid Protocol & WebID Pod Facade')).toBeInTheDocument();
    expect(within(off).getByText('Verifiable Trust Community (OpenVTC)')).toBeInTheDocument();
    expect(within(off).getByText('DIDComm Messaging v2.1')).toBeInTheDocument();
  });

  it('moves a standard to On when its flag is on', () => {
    h.enabledFlags = new Set(['ask', 'vtc.credentials']);
    render(<TrustProtocolsSection />);

    expect(
      within(screen.getByRole('region', { name: 'On (3)' })).getByText(
        'Verifiable Trust Community (OpenVTC)',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Off (6)' })).queryByText(
        'Verifiable Trust Community (OpenVTC)',
      ),
    ).not.toBeInTheDocument();
  });

  it('keeps the technical detail folded until Details is opened', () => {
    render(<TrustProtocolsSection />);

    expect(screen.queryByText('POST /vtc/verify, POST /vtc/status-list/evaluate')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Details for Verifiable Trust Community (OpenVTC)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('POST /vtc/verify, POST /vtc/status-list/evaluate')).toBeInTheDocument();
    expect(screen.getByText('ENABLE_VTC_CREDENTIALS=true')).toBeInTheDocument();
  });

  it('marks each unreviewed flag, and says beside its setting to leave it off', () => {
    render(<TrustProtocolsSection />);

    const caveat = 'Leave off until its security review is done';
    const row = (name: string) => screen.getByText(name).closest<HTMLElement>('[data-slot="settings-row"]')!;
    const unreviewed = [
      ['Trust Tasks HTTPS 0.3', 'ENABLE_TRUST_TASKS'],
      ['Portable Web Spaces (PWS)', 'ENABLE_PWS_STORAGE'],
      ['IdentiKey Post-Quantum Challenge Auth', 'ENABLE_AUTH_IDENTIKEY'],
      ['Verifiable Trust Community (OpenVTC)', 'ENABLE_VTC_CREDENTIALS'],
      ['DIDComm Messaging v2.1', 'ENABLE_DIDCOMM_MESSAGING'],
      ['MCP Protected Resource Metadata (PRM)', 'ENABLE_MCP_PRM'],
    ] as const;
    const reviewed = [
      'Solid Protocol & WebID Pod Facade',
      'Companion Asks & Delegated Consent',
      'Capability Attenuated API Keys & Field Crypto',
    ];

    expect(screen.getAllByText('Security review pending')).toHaveLength(unreviewed.length);

    for (const name of [...unreviewed.map(([unreviewedName]) => unreviewedName), ...reviewed]) {
      fireEvent.click(screen.getByRole('button', { name: `Details for ${name}` }));
    }

    expect(screen.getAllByText(caveat)).toHaveLength(unreviewed.length);
    for (const [name, envVar] of unreviewed) {
      expect(within(row(name)).getByText('Security review pending')).toBeInTheDocument();
      // The caveat sits in the same entry as that standard's setting.
      expect(within(row(name)).getByText(caveat).parentElement).toHaveTextContent(envVar);
    }

    for (const name of reviewed) {
      expect(within(row(name)).queryByText(caveat)).not.toBeInTheDocument();
      expect(within(row(name)).queryByText('Security review pending')).not.toBeInTheDocument();
    }
  });

  it('calls refresh when clicking Refresh flags', () => {
    render(<TrustProtocolsSection />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh flags/i }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
