import { ErrorPage } from '@ci/common/src/components/error-page/ErrorPage';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from './renderWithProviders';

/**
 * `ErrorPage` is the last thing a user sees when a route or a boundary blows up, on all
 * four targets, and it had no test. Its whole job is to survive being handed something
 * that is *not* an `Error` — the `error: unknown` prop is typed that way precisely because
 * a rejected fetch, a thrown string, or an Apollo error object all arrive here — so the
 * cases below are the non-`Error` ones. A regression that reads `.message` off `null`
 * would replace the error screen with a blank white page.
 */
describe('ErrorPage', () => {
  it('shows the message of a real Error', () => {
    renderWithProviders(<ErrorPage error={new Error('Could not reach CI-Server')} />);

    expect(screen.getByText('Could not reach CI-Server')).toBeInTheDocument();
  });

  it('falls back to "Unknown error!" for null and undefined', () => {
    const { unmount } = renderWithProviders(<ErrorPage error={null} />);
    expect(screen.getByText('Unknown error!')).toBeInTheDocument();
    unmount();

    renderWithProviders(<ErrorPage error={undefined} />);
    expect(screen.getByText('Unknown error!')).toBeInTheDocument();
  });

  it('falls back to "Unknown error!" for a thrown value with no message', () => {
    // `throw 'boom'` and `throw { status: 500 }` both reach here; reading `.message` off
    // them yields undefined, which must not render as the literal string "undefined".
    const { unmount } = renderWithProviders(<ErrorPage error="boom" />);
    expect(screen.getByText('Unknown error!')).toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
    unmount();

    renderWithProviders(<ErrorPage error={{ status: 500 }} />);
    expect(screen.getByText('Unknown error!')).toBeInTheDocument();
  });

  it('accepts any object carrying a message, not only Error instances', () => {
    // Apollo / fetch wrappers hand up plain objects that are structurally errors.
    renderWithProviders(<ErrorPage error={{ message: 'GraphQL request failed' }} />);

    expect(screen.getByText('GraphQL request failed')).toBeInTheDocument();
  });

  it('renders children (the recovery action) alongside the message', () => {
    renderWithProviders(
      <ErrorPage error={new Error('Session expired')}>
        <button type="button">Sign in again</button>
      </ErrorPage>,
    );

    expect(screen.getByText('Session expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });

  it('renders no children wrapper when none are passed', () => {
    // The `{children && …}` guard is what keeps an empty flex-gap block off the screen.
    const { container } = renderWithProviders(<ErrorPage error={new Error('Boom')} />);

    // Outer container + the message div, and nothing else.
    expect(container.querySelectorAll('div')).toHaveLength(2);
  });
});
