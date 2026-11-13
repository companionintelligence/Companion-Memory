import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsentDetailModal } from './ConsentDetailModal';
import type { AskAuditReceiptData } from './consentProvenance';

const SAMPLE_RECORD = {
  auditId: 'GlobalAuditId:1',
  askerName: 'Alice',
  consent: 'owner-decision' as const,
  channel: { keyThumbprint: null, verifiedAt: null, covered: [] },
  channelRecorded: false,
  ceiling: null,
  grantMode: null,
  arrivedAt: '2026-11-12T10:00:00.000Z',
  direction: 'inbound' as const,
  hasBody: true,
};

const SAMPLE_RECEIPT: AskAuditReceiptData = {
  auditId: 'GlobalAuditId:1',
  askId: 'GlobalAskId:1',
  auditSaid: 'IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  receipt: {
    d: 'IBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    schemaVersion: 'iso-27560:2023+dpv:v2',
    recordId: '11111111-1111-4111-8111-111111111111',
    piiPrincipalId: 'responder-1',
    recipient: 'alice@example.ts.net',
    legalBasis: 'dpv:ExplicitConsent',
    purposes: ['dpv:RequestedServiceProvision'],
    processing: ['dpv:Share', 'dpv:Transfer'],
    consentBasis: 'owner_approved',
    outcome: 'answered',
    disclosedCount: 2,
    issuedAt: '2026-11-12T10:00:00.000Z',
  },
};

describe('ConsentDetailModal', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('stays provider-free without onLoadReceipt for stories and standalone history lists', () => {
    render(<ConsentDetailModal record={SAMPLE_RECORD} onClose={vi.fn()} />);

    expect(screen.getByText('How this was protected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load consent receipt/i })).not.toBeInTheDocument();
  });

  it('loads and displays CESR SAID and ISO/IEC TS 27560 + DPV v2 consent receipt on demand', async () => {
    const onLoadReceipt = vi.fn().mockResolvedValue(SAMPLE_RECEIPT);
    render(<ConsentDetailModal record={SAMPLE_RECORD} onClose={vi.fn()} onLoadReceipt={onLoadReceipt} />);

    fireEvent.click(screen.getByRole('button', { name: /Load consent receipt & SAID/i }));

    await waitFor(() => {
      expect(onLoadReceipt).toHaveBeenCalledWith('GlobalAuditId:1');
      expect(screen.getByText(SAMPLE_RECEIPT.auditSaid)).toBeInTheDocument();
    });

    expect(screen.getByText(SAMPLE_RECEIPT.receipt.d)).toBeInTheDocument();
    expect(screen.getByText('iso-27560:2023+dpv:v2')).toBeInTheDocument();
    expect(screen.getByText('dpv:ExplicitConsent')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Copy receipt JSON/i }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(SAMPLE_RECEIPT, null, 2));
      expect(screen.getByText('Copied JSON')).toBeInTheDocument();
    });
  });

  it('surfaces an accessible alert when receipt retrieval returns null', async () => {
    const onLoadReceipt = vi.fn().mockResolvedValue(null);
    render(<ConsentDetailModal record={SAMPLE_RECORD} onClose={vi.fn()} onLoadReceipt={onLoadReceipt} />);

    fireEvent.click(screen.getByRole('button', { name: /Load consent receipt & SAID/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Consent receipt is unavailable for this record.');
    });
  });
});
