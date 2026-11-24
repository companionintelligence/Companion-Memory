import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { enterNativeShell, NATIVE_MEMORY_ORIGIN } from '@/test/nativeShell';
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

/**
 * QA MEM-09: inside the iOS app the page origin is `capacitor://localhost`, and
 * the link field, the QR code and the Email / Message tiles all took it — a
 * "share link" that opens nowhere on any other device. On the native shells the
 * link has to point at the Memory server the phone is paired with.
 */
describe('ShareSavedSearchModal on the native shell', () => {
  let leaveNativeShell: () => void = () => undefined;

  afterEach(() => leaveNativeShell());

  it('shows, copies and hands off a link on the paired Memory origin, not the WebView origin', async () => {
    leaveNativeShell = enterNativeShell();
    const link = `${NATIVE_MEMORY_ORIGIN}/shared/b6f3a1c20d9e4f7a8c1b2d3e4f5a6b7c`;

    renderWithProviders(<ShareSavedSearchModal savedSearch={mockSavedSearch()} onClose={() => {}} />);

    expect(await screen.findByDisplayValue(link)).toBeInTheDocument();

    // Email / Message carry the same link, encoded into the body.
    const email = screen.getByRole('link', { name: /email/i });
    expect(decodeURIComponent(email.getAttribute('href') ?? '')).toContain(link);

    fireEvent.click(screen.getByRole('button', { name: 'Show QR code' }));

    // The QR code's text fallback is the same URL it encodes.
    expect(screen.getAllByText(link).length).toBeGreaterThan(0);
  });
});
