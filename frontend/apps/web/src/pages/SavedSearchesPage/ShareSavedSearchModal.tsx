import { useEffect, useRef, useState } from 'react';

import { useMutation } from '@apollo/client';
import { Button, Dialog, IconButton, Label, useToast } from '@ci/shadcn';
import { Check, ClipboardCopy, Mail, MessageSquare, QrCode as QrCodeIcon } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { QrCode } from '@/components/QrCode';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SavedSearchGridItemFragment } from './SavedSearch';
import { shareUrl } from './shareLink';

interface Props {
  savedSearch: FragmentType<typeof SavedSearchGridItemFragment>;
  onClose: () => void;
  /**
   * Data attributes for the dialog's content. "Save & share" in the header
   * search panel marks it as part of that panel, so a click inside the
   * dialog doesn't close the panel underneath (and this dialog with it).
   */
  contentProps?: Record<`data-${string}`, string>;
}

// Mirrors LifeScope's tagUpdateSharing: the server mints/rotates the capability
// token when public is turned on and clears it when turned off.
const SET_SAVED_SEARCH_SHARING = gql(`
  mutation SetSavedSearchSharing($input: SetSavedSearchSharingInput!) {
    setSavedSearchSharing(input: $input) {
      success
      savedSearch {
        id
        # Spread keeps the grid card's cache entry in sync (the "Shared" badge);
        # the top-level isPublic/shareToken are unmasked so this modal can show
        # the freshly minted link without reopening (useFragment is not reactive).
        isPublic
        shareToken
        ...SavedSearchGridItemFragment
      }
    }
  }
`);

export function ShareSavedSearchModal({ savedSearch: savedSearchMask, onClose, contentProps }: Props) {
  const savedSearch = useFragment(SavedSearchGridItemFragment, savedSearchMask);
  const { t } = useTranslation();
  const { toast } = useToast();

  const [copied, setCopied] = useState<'link' | null>(null);
  const [showQr, setShowQr] = useState(false);
  const copyTimer = useRef<number | null>(null);
  // Local sharing state seeded from the (non-reactive) fragment and advanced by
  // the mutation result, so the link/embed appear the instant sharing is toggled.
  const [sharing, setSharingState] = useState<{ isPublic: boolean; shareToken: string | null }>({
    isPublic: savedSearch.isPublic,
    shareToken: savedSearch.shareToken ?? null,
  });

  const [setSharing, { loading }] = useMutation(SET_SAVED_SEARCH_SHARING);

  const isPublic = sharing.isPublic;
  const token = sharing.shareToken;
  const name = savedSearch.name || 'Untitled Saved Search';

  useEffect(
    () => () => {
      if (copyTimer.current) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  const handleSetSharing = async (next: boolean) => {
    if (next === isPublic) {
      return;
    }

    try {
      const result = await setSharing({
        variables: { input: { id: savedSearch.id, isPublic: next } },
      });

      const payload = result.data?.setSavedSearchSharing;
      const updated = payload?.savedSearch;

      // The server returns { success: false } (no thrown error) for rejected
      // changes — e.g. non-owner / not found. Keep prior state in that case so
      // the toggle doesn't lie about a change the server refused.
      if (!payload?.success || !updated) {
        toast.error('Couldn’t update sharing. Please try again.');

        return;
      }

      setSharingState({
        isPublic: updated.isPublic,
        shareToken: updated.shareToken ?? null,
      });
    } catch {
      // Leave the toggle reflecting the server's last-known state on failure.
      toast.error('Couldn’t update sharing. Please try again.');
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('link');
      if (copyTimer.current) {
        window.clearTimeout(copyTimer.current);
      }

      copyTimer.current = window.setTimeout(
        () => setCopied((current) => (current === 'link' ? null : current)),
        1500,
      );
      toast.success('Link copied');
    } catch {
      // Clipboard can be blocked (insecure context / denied permission); the text
      // is selectable in the field as a fallback.
      toast.error('Couldn’t copy link — select the text and copy manually.');
    }
  };

  const url = token ? shareUrl(token) : '';
  const shareTitle = `${name} — shared from Companion Memory`;
  // Facebook/LinkedIn dropped: `/shared/:token` is behind ProtectedRoute (see
  // App.tsx), so it only ever resolves for someone already signed in to this
  // appliance — a public-audience share button promises a link anyone can
  // open, which this one cannot be. Email/SMS still make sense because both
  // target one specific person, the same person the sender would separately
  // be telling "you'll need to sign in to see this".
  const socialLinks = token
    ? [
        {
          key: 'email',
          label: 'Email',
          Icon: Mail,
          href: `mailto:?subject=${encodeURIComponent(shareTitle)}&body=${encodeURIComponent(`${shareTitle}: ${url}`)}`,
        },
        {
          key: 'sms',
          label: 'Message',
          Icon: MessageSquare,
          href: `sms:?body=${encodeURIComponent(`${shareTitle} ${url}`)}`,
        },
      ]
    : [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content {...contentProps} className="sm:max-w-[560px]">
        <Dialog.Header>
          <Dialog.Title>Share “{name}”</Dialog.Title>
          <Dialog.Description>
            Anyone signed in to this Companion who has the link can view this search's results, run as you.
            They'll need an account here first — this isn't a public link.
          </Dialog.Description>
        </Dialog.Header>

        <div className="space-y-4 py-4">
          {/* Not Shared / Link Shared toggle (LifeScope parity). */}
          <div className="space-y-2">
            <Label>Visibility</Label>
            <div className="flex gap-2" role="group" aria-label="Sharing visibility">
              <Button
                variant={isPublic ? 'outline' : 'default'}
                className="flex-1"
                disabled={loading}
                aria-pressed={!isPublic}
                onClick={() => handleSetSharing(false)}
              >
                Not shared
              </Button>
              <Button
                variant={isPublic ? 'default' : 'outline'}
                className="flex-1"
                disabled={loading}
                aria-pressed={isPublic}
                onClick={() => handleSetSharing(true)}
              >
                Link shared
              </Button>
            </div>
          </div>

          {isPublic && token && (
            <>
              <div className="space-y-2">
                <Label>Share link</Label>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm break-all"
                  />
                  <IconButton
                    variant="outline"
                    label={t('SAVED_SEARCH_COPY_LINK')}
                    onClick={() => copyToClipboard(url)}
                  >
                    {copied === 'link' ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <ClipboardCopy className="w-4 h-4" />
                    )}
                  </IconButton>
                </div>
                <p className="text-xs text-muted-foreground">
                  Turning sharing off, then on again, issues a new link and disables the old one.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Share via</Label>
                <div className="flex flex-wrap gap-2">
                  {socialLinks.map(({ key, label, Icon, href }) => (
                    <Button key={key} variant="outline" size="sm" asChild>
                      <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
                        <Icon className="w-4 h-4" />
                        <span className="ml-1">{label}</span>
                      </a>
                    </Button>
                  ))}
                  {/*
                    A tile, not a link: the QR is the same intra-household hand-off
                    the mailto/sms tiles are, for the case where the other person is
                    stood next to you with their phone out and typing the token is
                    the only alternative.
                  */}
                  <Button
                    variant={showQr ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={showQr}
                    aria-label={showQr ? t('SAVED_SEARCH_HIDE_QR') : t('SAVED_SEARCH_SHOW_QR')}
                    onClick={() => setShowQr((current) => !current)}
                  >
                    <QrCodeIcon className="w-4 h-4" />
                    <span className="ml-1">QR code</span>
                  </Button>
                </div>

                {showQr && (
                  <div className="pt-2">
                    <QrCode value={url} fallback={url} caption="Scan to open on another device" mark />
                    {/*
                      Same caveat as the modal's own description, restated here
                      because a QR invites being pointed at a stranger's phone:
                      `/shared/:token` sits inside ProtectedRoute (App.tsx), so a
                      scan by someone without an account on this appliance lands
                      on the login wall, not the search.
                    */}
                    <p className="mt-2 text-center text-xs text-muted-foreground">
                      Scanning still lands on the sign-in screen for anyone without an account on this
                      Companion.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <Dialog.Footer>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}
