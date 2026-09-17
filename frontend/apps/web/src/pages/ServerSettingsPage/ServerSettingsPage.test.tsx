import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerSettingsPage } from './ServerSettingsPage';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const h = vi.hoisted(() => ({
  apiBaseUrl: '',
  ios: false,
  persistApiBaseUrl: vi.fn(),
  completeMemoryPasswordConnect: vi.fn(async () => true),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  getApiBaseUrl: () => h.apiBaseUrl,
  isIosPlatform: () => h.ios,
  persistApiBaseUrl: h.persistApiBaseUrl,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [
    { authenticated: false, initializing: false },
    { completeMemoryPasswordConnect: h.completeMemoryPasswordConnect },
  ],
}));

beforeEach(() => {
  h.apiBaseUrl = '';
  h.ios = false;
  h.persistApiBaseUrl.mockReset();
  h.completeMemoryPasswordConnect.mockReset();
  h.completeMemoryPasswordConnect.mockResolvedValue(true);
  navigate.mockReset();
  localStorage.clear();
});

describe('ServerSettingsPage', () => {
  it('defaults the Companion URL to production hub.ci.computer', () => {
    render(<ServerSettingsPage />);

    expect(screen.getByLabelText('Companion URL')).toHaveValue('https://hub.ci.computer');
    expect(screen.queryByText(/portal/i)).not.toBeInTheDocument();
  });

  it('names Safari on iOS and stays browser-neutral everywhere else', () => {
    const { unmount } = render(<ServerSettingsPage />);

    expect(screen.getByText(/Your browser signs in here\./)).toBeInTheDocument();
    expect(screen.queryByText(/Safari/)).not.toBeInTheDocument();
    unmount();

    h.ios = true;
    render(<ServerSettingsPage />);

    expect(screen.getByText(/Safari signs in here\./)).toBeInTheDocument();
  });

  it('saves the Companion URL and returns to Log in', () => {
    render(<ServerSettingsPage />);

    fireEvent.change(screen.getByLabelText('Companion URL'), {
      target: { value: 'https://hub.ci.computer' },
    });
    fireEvent.submit(screen.getByRole('button', { name: /^save url$/i }).closest('form')!);

    expect(localStorage.getItem('ci.deviceConnect.portalUrl')).toBe('https://hub.ci.computer');
    expect(navigate).toHaveBeenCalledWith('/device-connect');
    expect(h.persistApiBaseUrl).not.toHaveBeenCalled();
  });

  it('does not offer a Memory URL field that pretends to connect the phone', () => {
    render(<ServerSettingsPage />);

    expect(screen.getByTestId('memory-origin-hint')).toHaveTextContent(/not paired yet/i);
    expect(screen.queryByLabelText('Memory Server URL')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /test & connect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /scan qr code/i })).not.toBeInTheDocument();
  });

  it('hides offline email unlock until this phone already has a paired Memory origin', () => {
    render(<ServerSettingsPage />);

    expect(screen.queryByTestId('local-unlock-submit')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('you@example.com')).not.toBeInTheDocument();
  });

  it('unlocks an already-paired Memory with email and password, without Portal login', async () => {
    h.apiBaseUrl = 'https://memory.example.com';

    render(<ServerSettingsPage />);

    expect(screen.getByTestId('memory-origin-hint')).toHaveTextContent('https://memory.example.com');
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByTestId('local-unlock-submit'));

    await waitFor(() => {
      expect(h.completeMemoryPasswordConnect).toHaveBeenCalledWith(
        'a@b.com',
        'secret',
        'https://memory.example.com',
      );
    });
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('does not treat a leftover docker origin as a paired Memory', () => {
    h.apiBaseUrl = 'http://localhost:64669';

    render(<ServerSettingsPage />);

    expect(screen.queryByTestId('local-unlock-submit')).not.toBeInTheDocument();
    expect(screen.getByTestId('memory-origin-hint')).toHaveTextContent(/not paired yet/i);
  });
});
