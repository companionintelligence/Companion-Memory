import { useState } from 'react';

import { useMutation, useQuery } from '@apollo/client/react';
import { Badge, Button, Card, Input, Textarea } from '@ci/shadcn';

import {
  ACCEPT_PEER_INVITE,
  CREATE_PEER_INVITE,
  MY_PEER_INVITES,
  REVOKE_PEER_INVITE,
} from './asksOperations';
import { SafetyCode } from './PeerManager';

interface Props {
  /** Called after a link was made, so the page re-reads its roster. */
  onLinked: () => void;
}

/** The message an Apollo error carries, which for these mutations is the server's own plain sentence. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Linking with someone on another Companion, by invite.
 *
 * One person makes an invite and sends its code to the other however they
 * like; the other pastes it. Both Companions check each other's key and link
 * each other as Stranger, and from then on either can ask the other.
 *
 * ═══ THE CODE IS SHOWN ONCE ═══
 *
 * The server keeps only a hash of the code's secret, so it cannot show the code
 * again. The copy says so, because an owner who navigates away expecting to
 * come back for it would otherwise hunt for something that does not exist.
 */
export function PeerInvites({ onLinked }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <InviteSomeone />
      <AcceptInvite onLinked={onLinked} />
    </div>
  );
}

function InviteSomeone() {
  const invites = useQuery(MY_PEER_INVITES);
  const [createInvite, creating] = useMutation(CREATE_PEER_INVITE, {
    refetchQueries: [{ query: MY_PEER_INVITES }],
  });
  const [revokeInvite, revoking] = useMutation(REVOKE_PEER_INVITE, {
    refetchQueries: [{ query: MY_PEER_INVITES }],
  });
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [made, setMade] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waiting = (invites.data?.myPeerInvites ?? []).filter((invite) => invite.status === 'pending');
  const busy = creating.loading || revoking.loading;

  const make = async () => {
    setError(null);
    setCopied(false);

    try {
      const result = await createInvite({
        variables: { input: { name: name.trim() || undefined, label: label.trim() || undefined } },
      });
      const payload = result.data?.createPeerInvite;

      if (payload?.code && payload.invite) {
        setMade({ code: payload.code, expiresAt: payload.invite.expiresAt });
        setName('');
        setLabel('');
      } else {
        setError('Invites are turned off on this Companion.');
      }
    } catch (err) {
      setError(messageOf(err, 'Could not make an invite.'));
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard blocked: the code is on screen and selectable.
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <p className="font-medium">Invite someone</p>
      <p className="text-muted-foreground text-xs">
        Make a code and send it to them yourself — a message, an email, in person. When they paste it into
        their Companion, you are linked to each other as <strong>Stranger</strong>.
      </p>

      {made ? (
        <div className="flex flex-col gap-2" role="status">
          <Textarea
            readOnly
            value={made.code}
            aria-label="Invite code"
            className="font-mono text-xs"
            rows={3}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void copy(made.code)}>
              {copied ? 'Copied' : 'Copy code'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMade(null)}>
              Done
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Works once, until {formatTime(made.expiresAt)}. Anyone holding it can link to you, so send it only
            to them. This is the only time it is shown: your Companion keeps no copy.
          </p>
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-sm">The name they will see (optional)</span>
            <Input
              value={name}
              disabled={busy}
              placeholder="Your name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm">Who it is for — only you see this (optional)</span>
            <Input value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <div>
            <Button disabled={busy} onClick={() => void make()}>
              Make an invite
            </Button>
          </div>
        </>
      )}

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      {waiting.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Waiting to be used</span>
          {waiting.map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>{invite.label || `as ${invite.inviterName}`}</span>
              <Badge variant="outline" className="text-xs">
                until {formatTime(invite.expiresAt)}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void revokeInvite({ variables: { id: invite.id } }).catch(() => undefined)}
              >
                Withdraw
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function AcceptInvite({ onLinked }: Props) {
  const [acceptInvite, accepting] = useMutation(ACCEPT_PEER_INVITE);
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [linked, setLinked] = useState<{ name: string; safetyCode: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setError(null);
    setLinked(null);

    try {
      const result = await acceptInvite({
        variables: { input: { code: code.trim(), displayName: displayName.trim() || undefined } },
      });
      const link = result.data?.acceptPeerInvite?.peerLink;

      if (link) {
        setLinked({ name: link.displayName || link.peerHandle, safetyCode: link.safetyCode ?? null });
        setCode('');
        setDisplayName('');
        onLinked();
      } else {
        setError('Invites are turned off on this Companion.');
      }
    } catch (err) {
      setError(messageOf(err, 'Could not use that invite.'));
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <p className="font-medium">Have an invite?</p>

      <label className="flex flex-col gap-1">
        <span className="text-sm">Paste the code they sent you</span>
        <Textarea
          value={code}
          rows={3}
          className="font-mono text-xs"
          placeholder="cmi1.…"
          disabled={accepting.loading}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm">What you want to call them (optional)</span>
        <Input
          value={displayName}
          disabled={accepting.loading}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>

      <div>
        <Button disabled={accepting.loading || code.trim().length === 0} onClick={() => void accept()}>
          {accepting.loading ? 'Linking…' : 'Link'}
        </Button>
      </div>

      {linked ? (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-sm">
            Linked with {linked.name}, as Stranger. You can ask them from “Ask someone” now.
          </p>
          {linked.safetyCode ? <SafetyCode code={linked.safetyCode} name={linked.name} /> : null}
        </div>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </Card>
  );
}
