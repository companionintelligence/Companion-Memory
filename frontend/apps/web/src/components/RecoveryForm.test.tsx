import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverWithCode, RecoveryForm } from './RecoveryForm';

const h = vi.hoisted(() => ({ fetchJson: vi.fn(), native: false }));
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
  isNativePlatform: () => h.native,
}));

beforeEach(() => {
  h.fetchJson.mockReset();
  h.native = false;
});

describe('recovery request', () => {
  it.each([false, true])('uses a fresh CSRF token and no stale API key (native=%s)', async (native) => {
    h.native = native;
    h.fetchJson.mockResolvedValueOnce({ csrfToken: 'fresh-token' }).mockResolvedValueOnce(undefined);
    await recoverWithCode('owner@example.test', 'saved-code', 'new-password');
    expect(h.fetchJson).toHaveBeenNthCalledWith(
      1,
      '/api/authenticate/csrf',
      expect.objectContaining({
        credentials: native ? 'omit' : 'include',
        skipApiKey: true,
      }),
    );
    expect(h.fetchJson).toHaveBeenNthCalledWith(
      2,
      '/api/account-recovery',
      expect.objectContaining({
        method: 'POST',
        credentials: native ? 'omit' : 'include',
        skipApiKey: true,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'fresh-token' },
        body: JSON.stringify({
          email: 'owner@example.test',
          code: 'saved-code',
          newPassword: 'new-password',
        }),
      }),
    );
  });

  it('does not send a recovery request when CSRF bootstrap fails', async () => {
    h.fetchJson.mockResolvedValueOnce(undefined);
    await expect(recoverWithCode('owner@example.test', 'saved-code', 'new-password')).rejects.toThrow(
      'Could not begin',
    );
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
  });
});

describe('RecoveryForm', () => {
  function fill() {
    render(<RecoveryForm />);
    document.querySelector('details')!.open = true;
    fireEvent.change(screen.getByLabelText('Account email'), { target: { value: 'owner@example.test' } });
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'saved-code' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'replacement-password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'replacement-password' },
    });
  }

  it('keeps the saved code available after an error and allows a successful retry', async () => {
    fill();
    h.fetchJson
      .mockResolvedValueOnce({ csrfToken: 'first' })
      .mockRejectedValueOnce(new Error('Code has already been used'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Code has already been used');
    expect(screen.getByLabelText('Recovery code')).toHaveValue('saved-code');
    h.fetchJson.mockResolvedValueOnce({ csrfToken: 'second' }).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password reset. Sign in again');
    expect(screen.queryByLabelText('Recovery code')).not.toBeInTheDocument();
  });

  it('requires matching passwords before sending credentials', async () => {
    fill();
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'different-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('New passwords do not match'));
    expect(h.fetchJson).not.toHaveBeenCalled();
  });
});
