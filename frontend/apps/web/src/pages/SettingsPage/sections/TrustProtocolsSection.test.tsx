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

  it('renders live feature-flag status and identifies fail-closed 404 provisional surfaces', () => {
    render(<TrustProtocolsSection />);

    expect(screen.getByText('Trust, Identity & Protocol Standards')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All (9)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Active (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fail-closed 404 (7)' })).toBeInTheDocument();

    expect(screen.getByText('Solid Protocol & WebID Pod Facade')).toBeInTheDocument();
    expect(screen.getByText('Verifiable Trust Community (OpenVTC)')).toBeInTheDocument();
    expect(screen.getByText('DIDComm Messaging v2.1')).toBeInTheDocument();
  });

  it('filters by active state and searches by standard, flag, or endpoint', () => {
    h.enabledFlags = new Set(['ask', 'vtc.credentials']);
    render(<TrustProtocolsSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Active (3)' }));
    expect(screen.getByText('Verifiable Trust Community (OpenVTC)')).toBeInTheDocument();
    expect(screen.queryByText('DIDComm Messaging v2.1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All (9)' }));
    fireEvent.change(screen.getByLabelText('Filter protocols'), { target: { value: 'eddsa-jcs-2022' } });
    expect(screen.getByText('Verifiable Trust Community (OpenVTC)')).toBeInTheDocument();
    expect(screen.queryByText('Solid Protocol & WebID Pod Facade')).not.toBeInTheDocument();
  });

  it('says beside each unreviewed flag to leave it off, and on no other card', () => {
    render(<TrustProtocolsSection />);

    const caveat = 'Leave off until its security review is done';
    const card = (name: string) => screen.getByText(name).closest<HTMLElement>('[data-slot="card"]')!;
    const unreviewed = [
      ['Trust Tasks HTTPS 0.3', 'ENABLE_TRUST_TASKS'],
      ['Portable Web Spaces (PWS)', 'ENABLE_PWS_STORAGE'],
      ['IdentiKey Post-Quantum Challenge Auth', 'ENABLE_AUTH_IDENTIKEY'],
      ['Verifiable Trust Community (OpenVTC)', 'ENABLE_VTC_CREDENTIALS'],
      ['DIDComm Messaging v2.1', 'ENABLE_DIDCOMM_MESSAGING'],
      ['MCP Protected Resource Metadata (PRM)', 'ENABLE_MCP_PRM'],
    ] as const;

    expect(screen.getAllByText(caveat)).toHaveLength(unreviewed.length);
    for (const [name, envVar] of unreviewed) {
      // The caveat sits in the same group as that card's activation line.
      expect(within(card(name)).getByText(caveat).parentElement).toHaveTextContent(envVar);
    }

    for (const name of [
      'Solid Protocol & WebID Pod Facade',
      'Companion Asks & Delegated Consent',
      'Capability Attenuated API Keys & Field Crypto',
    ]) {
      expect(within(card(name)).queryByText(caveat)).not.toBeInTheDocument();
    }
  });

  it('calls refresh when clicking Refresh flags', () => {
    render(<TrustProtocolsSection />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh flags/i }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
