import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { mockSavedSearch } from './_storyHelpers';
import { ShareSavedSearchModal } from './ShareSavedSearchModal';

/**
 * B13: the modal used to render an "Embed" iframe snippet and Facebook/LinkedIn
 * buttons. `/shared/:token` is behind ProtectedRoute (App.tsx) and the session
 * cookie is `sameSite: 'lax'`, so a third-party iframe or a public social post
 * can never resolve for a visitor who isn't already signed in to this
 * appliance — nothing in the modal said so. The embed section and the two
 * public-audience buttons are gone; Email/Message remain because both target
 * one specific person who can be told separately they'll need an account.
 */
describe('ShareSavedSearchModal — no controls that promise a public link', () => {
  it('renders the copyable link and Email/Message, but no Embed section or Facebook/LinkedIn', async () => {
    renderWithProviders(<ShareSavedSearchModal savedSearch={mockSavedSearch()} onClose={() => {}} />);

    expect(await screen.findByText('Share link')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /email/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /message/i })).toBeInTheDocument();

    expect(screen.queryByText('Embed')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /facebook/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /linkedin/i })).not.toBeInTheDocument();
  });

  it('tells the recipient this is not a public link', async () => {
    renderWithProviders(<ShareSavedSearchModal savedSearch={mockSavedSearch()} onClose={() => {}} />);

    expect(await screen.findByText(/isn't a public link/i)).toBeInTheDocument();
  });

  /**
   * The QR tile is a hand-off to the person next to you, so it inherits the
   * same caveat as the rest of the modal and has to say so on screen — a code
   * pointed at a stranger's phone lands them on the sign-in wall.
   */
  it('shows the QR code on demand, with its own sign-in caveat and the link in text', async () => {
    renderWithProviders(<ShareSavedSearchModal savedSearch={mockSavedSearch()} onClose={() => {}} />);

    const toggle = await screen.findByRole('button', { name: 'Show QR code' });

    expect(screen.queryByText('Scan to open on another device')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByText('Scan to open on another device')).toBeInTheDocument();
    expect(screen.getByText(/lands on the sign-in screen/i)).toBeInTheDocument();
    // The fallback: the same URL the code encodes, selectable rather than scanned.
    expect(screen.getAllByText(/\/shared\//).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Hide QR code' })).toBeInTheDocument();
  });
});
