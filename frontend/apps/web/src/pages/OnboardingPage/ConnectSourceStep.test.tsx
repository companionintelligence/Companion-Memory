import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ConnectSourceStep } from './ConnectSourceStep';
import { CHROME_EXTENSION_URL, FIREFOX_EXTENSION_URL } from './constants';

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
    const servicesIntro = screen.getByText(/Connect an account you already use/);
    const services = screen.getByTestId('service-integrations');
    const macos = screen.getByRole('button', { name: /macOS/ });
    const chrome = screen.getByRole('button', { name: /Chrome/ });

    expect(capture.compareDocumentPosition(extension) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extension.compareDocumentPosition(servicesIntro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(servicesIntro.compareDocumentPosition(services) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(macos.compareDocumentPosition(chrome) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chrome.compareDocumentPosition(services) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the Firefox add-on listing instead of marking it coming soon', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderStep();

    const firefox = screen.getByRole('button', { name: /Firefox/ });
    expect(firefox).not.toBeDisabled();
    expect(firefox).not.toHaveTextContent(/coming soon/i);

    fireEvent.click(firefox);
    expect(open).toHaveBeenCalledWith(FIREFOX_EXTENSION_URL, '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('opens the Chrome Web Store listing without anyone\'s account index attached', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderStep();

    fireEvent.click(screen.getByRole('button', { name: /Chrome/ }));

    expect(open).toHaveBeenCalledWith(CHROME_EXTENSION_URL, '_blank', 'noopener,noreferrer');
    expect(CHROME_EXTENSION_URL).not.toMatch(/[?&](authuser|hl)=/);
    open.mockRestore();
  });

  it('keeps the iPhone & iPad card inert — the iOS app is a closed preview with nothing to download', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderStep();

    const iphone = screen.getByRole('button', { name: /iPhone & iPad/ });
    expect(iphone).toBeDisabled();
    expect(iphone).toHaveTextContent(/coming soon/i);

    fireEvent.click(iphone);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
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
