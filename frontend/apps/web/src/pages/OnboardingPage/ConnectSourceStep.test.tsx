import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ConnectSourceStep } from './ConnectSourceStep';

vi.mock('@/components/connect/ConnectedAccountsSection', () => ({
  ConnectedAccountsSection: () => <div data-testid="connected-accounts">Accounts</div>,
}));

vi.mock('@/components/connect/ServiceIntegrationsSection', () => ({
  ServiceIntegrationsSection: () => (
    <div data-testid="service-integrations">
      <button type="button">Google</button>
    </div>
  ),
}));

vi.mock('@/components/connect/ProviderConnectDialog', () => ({
  ProviderConnectDialog: () => null,
}));

function renderStep() {
  return render(
    <MemoryRouter>
      <ConnectSourceStep />
    </MemoryRouter>,
  );
}

describe('ConnectSourceStep', () => {
  it('shows Capture, then the browser extension, then service cards', () => {
    renderStep();

    const capture = screen.getByText(/Companion Capture/);
    const extension = screen.getByText(/browser extension/i);
    const services = screen.getByTestId('service-integrations');
    const macos = screen.getByRole('button', { name: /macOS/ });
    const chrome = screen.getByRole('button', { name: /Chrome/ });

    expect(capture.compareDocumentPosition(extension) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extension.compareDocumentPosition(services) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(macos.compareDocumentPosition(chrome) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chrome.compareDocumentPosition(services) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists connected accounts above the service gallery', () => {
    renderStep();

    const accounts = screen.getByTestId('connected-accounts');
    const services = screen.getByTestId('service-integrations');
    expect(accounts.compareDocumentPosition(services) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps service cards clickable so another account can be added', () => {
    renderStep();
    expect(screen.getByRole('button', { name: 'Google' })).not.toBeDisabled();
  });
});
