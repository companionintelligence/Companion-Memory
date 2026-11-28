import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_SIGN_IN_ENDED_NOTICE, MemorySignInEndedBanner } from './MemorySignInEndedBanner';

const h = vi.hoisted(() => ({
  signInEnded: false,
  native: false,
  logout: vi.fn(async () => undefined),
  navigate: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => [{ signInEnded: h.signInEnded }, { logout: h.logout }],
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => h.native,
}));

afterEach(() => {
  h.signInEnded = false;
  h.native = false;
  vi.clearAllMocks();
});

describe('MemorySignInEndedBanner', () => {
  it('shows nothing while Memory takes this device’s key', () => {
    render(<MemorySignInEndedBanner />);

    expect(screen.queryByTestId('memory-sign-in-ended-notice')).not.toBeInTheDocument();
  });

  it('says what happened, and that what is waiting to upload is kept', () => {
    h.signInEnded = true;

    render(<MemorySignInEndedBanner />);

    expect(screen.getByRole('status')).toHaveTextContent(MEMORY_SIGN_IN_ENDED_NOTICE);
    expect(MEMORY_SIGN_IN_ENDED_NOTICE).toMatch(/kept/);
  });

  it('on the phone, opens device connect to sign in again, without signing out', () => {
    h.signInEnded = true;
    h.native = true;

    render(<MemorySignInEndedBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(h.navigate).toHaveBeenCalledWith('/device-connect');
    expect(h.logout).not.toHaveBeenCalled();
  });

  it('on the desktop, signs the window out to its own sign-in page', () => {
    h.signInEnded = true;

    render(<MemorySignInEndedBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
