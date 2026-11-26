import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecoveryCodesSection } from './RecoveryCodesSection';

const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));
vi.mock('@/hooks', () => ({ useAuth: () => [{ authToken: 'access-token' }] }));

beforeEach(() => {
  h.fetchJson.mockReset();
});

describe('RecoveryCodesSection', () => {
  const codes = ['CMR-saved-code-one', 'CMR-saved-code-two'];
  it('requires reauthentication and clears the displayed codes when marked saved', async () => {
    h.fetchJson.mockResolvedValue({ codes });
    render(<RecoveryCodesSection requiresPassword />);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'current-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate new recovery codes' }));
    expect(await screen.findByText(codes[0])).toBeInTheDocument();
    expect(h.fetchJson).toHaveBeenCalledWith(
      '/api/account/recovery-codes',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
        body: JSON.stringify({ currentPassword: 'current-secret' }),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'I saved these codes' }));
    expect(screen.queryByText(codes[0])).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });

  it('shows the retryable failure without exposing or storing codes', async () => {
    h.fetchJson.mockRejectedValue(new Error('Current password is incorrect'));
    render(<RecoveryCodesSection requiresPassword />);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate new recovery codes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
    expect(screen.getByRole('button', { name: 'Generate new recovery codes' })).toBeEnabled();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('explains manual copying when the clipboard API is unavailable', async () => {
    h.fetchJson.mockResolvedValue({ codes });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(<RecoveryCodesSection requiresPassword={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate new recovery codes' }));
    await screen.findByText(codes[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy codes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Select and copy the codes manually');
  });
});
