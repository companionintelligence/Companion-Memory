import { FetchJsonError } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignupForm } from './SignupForm';

// The form owns no password rules — the backend signup schema is the single
// source of truth, and its zod issues are mapped back onto the fields, but
// only for submissions made by this mounted form (useAuth's error is
// app-wide state that survives navigation).
const h = vi.hoisted(() => ({
  error: null as unknown,
  codesRequired: false,
}));

vi.mock('../../hooks', () => ({
  useAuth: () => [{ loading: false, error: h.error }, {}],
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => h.codesRequired }),
}));

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test User' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: '123' } });
  fireEvent.click(screen.getByRole('button', { name: /sign up/i }));
}

describe('SignupForm server validation feedback', () => {
  it('renders the pristine form when there is no error at all', () => {
    // The default state: useAuth reports no error. Reading error.message
    // unguarded here crashed the whole app on every page load.
    h.error = null;

    render(<SignupForm />);

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign up/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a fallback message for a non-Error rejection', () => {
    // useAuth stores whatever was thrown; a string or object must not blank
    // the page or render "undefined" in the alert.
    h.error = 'boom';

    render(<SignupForm />);

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
  });

  it('maps field-level issues onto the inputs after a submission', async () => {
    h.error = new FetchJsonError(400, 'Bad Request', 'Validation failed', [
      { path: ['password'], message: 'Password must be at least 6 characters' },
    ]);

    render(<SignupForm />);
    fillAndSubmit();

    // waitFor polls on a timer; findByText waits on DOM mutations alone and
    // can miss react-hook-form's submit settling when the mock resolves
    // without ever yielding to a macrotask.
    await waitFor(() =>
      expect(screen.getByText('Password must be at least 6 characters')).toBeInTheDocument(),
    );
    // Every issue landed on a field, so the generic alert stays hidden.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not paint stale field errors onto a form that has not submitted', () => {
    h.error = new FetchJsonError(400, 'Bad Request', 'Validation failed', [
      { path: ['password'], message: 'Password must be at least 6 characters' },
    ]);

    render(<SignupForm />);

    // No field is marked invalid before this form has been submitted...
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'false');
    // ...but the alert still states the actual rule rather than the opaque
    // "Validation failed" envelope.
    expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 6 characters');
    expect(screen.queryByRole('alert')).not.toHaveTextContent('Validation failed');
  });

  it('resurfaces the alert when editing clears a mapped field error', async () => {
    h.error = new FetchJsonError(400, 'Bad Request', 'Validation failed', [
      { path: ['password'], message: 'Password must be at least 6 characters' },
    ]);

    render(<SignupForm />);
    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByText('Password must be at least 6 characters')).toBeInTheDocument(),
    );

    // First keystroke after the failed submit revalidates and clears the
    // server-mapped error; the failure must not become invisible.
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'longenough' } });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 6 characters'),
    );
  });

  it('keeps unmapped issues visible in the alert alongside mapped ones', async () => {
    h.error = new FetchJsonError(400, 'Bad Request', 'Validation failed', [
      { path: ['password'], message: 'Password must be at least 6 characters' },
      { path: ['terms_accepted'], message: 'You must accept the terms' },
    ]);

    render(<SignupForm />);
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByText('Password must be at least 6 characters')).toBeInTheDocument(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('You must accept the terms');
  });

  it('routes signup_code issues to the alert when its input is not rendered', async () => {
    h.error = new FetchJsonError(400, 'Bad Request', 'Validation failed', [
      { path: ['signup_code'], message: 'Signup code is required' },
    ]);

    render(<SignupForm />);
    fillAndSubmit();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Signup code is required'));
  });

  it('falls back to the alert for errors without field issues', () => {
    h.error = new FetchJsonError(400, 'Bad Request', 'Email already in use');

    render(<SignupForm />);

    expect(screen.getByRole('alert')).toHaveTextContent('Email already in use');
  });
});

/**
 * `require.signup.codes` mounts a whole field — and that field's presence is
 * what an issue on `signup_code` maps onto. The existing test above only
 * covers the flag OFF, where a signup_code issue has nowhere to land but the
 * alert; this covers it ON, where the field exists and must be the one that
 * shows the message.
 */
describe('SignupForm signup code requirement', () => {
  afterEach(() => {
    h.codesRequired = false;
  });

  it('shows the signup code field only when the appliance requires one', () => {
    h.codesRequired = true;
    h.error = null;

    render(<SignupForm />);

    expect(screen.getByLabelText('Signup Code')).toBeInTheDocument();
  });

  it('hides the signup code field when the appliance does not require one', () => {
    h.codesRequired = false;
    h.error = null;

    render(<SignupForm />);

    expect(screen.queryByLabelText('Signup Code')).not.toBeInTheDocument();
  });

  it('maps a signup_code issue onto its own field once the field exists, instead of the alert', async () => {
    h.codesRequired = true;
    h.error = new FetchJsonError(400, 'Bad Request', 'Validation failed', [
      { path: ['signup_code'], message: 'That signup code has already been used' },
    ]);

    render(<SignupForm />);
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByText('That signup code has already been used')).toBeInTheDocument(),
    );
    // Landed on the field, so the generic envelope alert stays hidden — the
    // same contract the password field already gets.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still shows an unrelated issue in the alert alongside the mapped signup_code field error', async () => {
    h.codesRequired = true;
    h.error = new FetchJsonError(400, 'Bad Request', 'Validation failed', [
      { path: ['signup_code'], message: 'That signup code has already been used' },
      { path: ['terms_accepted'], message: 'You must accept the terms' },
    ]);

    render(<SignupForm />);
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByText('That signup code has already been used')).toBeInTheDocument(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('You must accept the terms');
  });
});

describe('SignupForm email field', () => {
  it('configures the email field for an address on a touch keyboard', () => {
    h.error = null;
    render(<SignupForm />);

    const email = screen.getByLabelText('Email');

    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('inputmode', 'email');
    expect(email).toHaveAttribute('autocapitalize', 'none');
    expect(email).toHaveAttribute('autocorrect', 'off');
    expect(email).toHaveAttribute('spellcheck', 'false');
    expect(email).toHaveAttribute('autocomplete', 'username');
  });

  it('still shows the schema message, not the browser bubble, for an invalid address', async () => {
    // type="email" alone would make the browser block the submit with its own tooltip.
    h.error = null;
    const onSubmit = vi.fn();
    render(<SignupForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    expect(await screen.findByText('Invalid email.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
