import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoginForm } from './LoginForm';

const h = vi.hoisted(() => ({ loading: false, error: null as Error | null }));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ loading: h.loading, error: h.error, authToken: null, expired: true }, {}],
}));

afterEach(() => {
  h.loading = false;
  h.error = null;
});

describe('LoginForm', () => {
  it('renders email, password and the submit button', () => {
    render(<LoginForm />);

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });

  it('submits the entered credentials', async () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jsmith@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'jsmith@example.com', password: 'secret' }),
        expect.anything(),
      ),
    );
  });

  it('rejects an invalid email and does not submit', async () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Invalid email.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('surfaces an auth error', () => {
    h.error = new Error('Invalid credentials');
    render(<LoginForm />);

    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
  });

  it('gives the error alert a surface of its own, not the card colour', () => {
    // The alert sits inside a Card. While the destructive variant used `bg-card`
    // the box was the same colour as its container, so a one-line error rendered
    // as floating red text with ~40px of unexplained space above it — read by
    // users as broken margins rather than as an alert.
    h.error = new Error('Invalid credentials');
    render(<LoginForm />);

    const alert = screen.getByRole('alert');

    expect(alert.className).toContain('bg-destructive/5');
    expect(alert.className).toContain('border-destructive/20');
    expect(alert.className).not.toContain('bg-card');
  });
});
