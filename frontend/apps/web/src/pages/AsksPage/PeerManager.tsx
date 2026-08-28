import { useState } from 'react';

import { Badge, Button, Card, Input } from '@ci/shadcn';

import { PersonAvatar } from '@/components/PersonAvatar';

import {
  PEER_TRUST_TIERS,
  peerTrustCeilingNote,
  peerTrustLabel,
  type PeerTrustTier,
  widensPeerTrust,
} from './askPresentation';

export interface PeerRow {
  id: string;
  peerHandle: string;
  displayName?: string | null;
  /** The linked Person's photo, when set. Null renders initials. */
  avatarUrl?: string | null;
  memoryEndpoint: string;
  trustTier: string;
  status: string;
  revokedAt?: string | null;
}

interface Props {
  peers: readonly PeerRow[];
  busy?: boolean;
  onChangeTier: (id: string, tier: PeerTrustTier) => void;
  onRevoke: (id: string) => void;
  onAdd: (input: { peerHandle: string; memoryEndpoint: string; displayName?: string }) => void;
}

/**
 * "People I'm linked to" — the peer roster, and the tier dial on each one.
 *
 * ═══ THE TIER IS THE POINT, NOT THE NAME ═══
 *
 * A peer link looks like an address-book entry and is not one. `trustTier` maps
 * straight onto a maximum disclosure rung in `policy.ts`, and that ceiling is
 * applied to EVERY answer that peer ever receives, on top of whatever grants
 * say. Demoting someone from `trusted` to `stranger` narrows every future
 * answer to them without touching a single grant; promoting them widens every
 * future answer the same way. An owner who cannot see that number cannot govern
 * their own disclosure, which is why the tier is rendered as four labelled
 * buttons with the ceiling spelled out underneath rather than as a chip.
 *
 * ═══ WIDENING ASKS TWICE; NARROWING DOES NOT ═══
 *
 * The four buttons are not symmetric, deliberately. Moving DOWN the ladder is
 * applied on the first tap: hesitating in front of a confirmation dialog is
 * exactly the wrong thing to make someone do at the moment they have decided to
 * trust a person less. Moving UP asks for a second, explicit tap, because it is
 * the gesture that can retroactively enlarge answers to asks that have not been
 * sent yet, and because a mis-tap on a four-button row is otherwise a silent
 * escalation. {@link widensPeerTrust} decides which is which.
 *
 * A REVOKED link keeps its row, with its controls gone. Nothing is deleted on
 * the server either — the owner is entitled to see that the relationship
 * existed, and a revocation the UI hides is one they cannot verify happened.
 */
export function PeerManager({ peers, busy = false, onChangeTier, onRevoke, onAdd }: Props) {
  const [confirming, setConfirming] = useState<{ id: string; tier: PeerTrustTier } | null>(null);

  const requestTier = (peer: PeerRow, tier: PeerTrustTier) => {
    if (tier === peer.trustTier) {
      return;
    }

    if (widensPeerTrust(peer.trustTier, tier)) {
      setConfirming({ id: peer.id, tier });

      return;
    }

    setConfirming(null);
    onChangeTier(peer.id, tier);
  };

  return (
    <div className="flex flex-col gap-3">
      {peers.map((peer) => {
        const revoked = peer.revokedAt != null || peer.status === 'revoked';
        const pending = confirming?.id === peer.id ? confirming.tier : null;

        return (
          <Card key={peer.id} className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <PersonAvatar name={peer.displayName || peer.peerHandle} avatarUrl={peer.avatarUrl} size="xs" />
              <span className="font-medium">{peer.displayName || peer.peerHandle}</span>
              <span className="text-muted-foreground text-xs">{peer.peerHandle}</span>
              <Badge variant={revoked ? 'outline' : 'secondary'} className="text-xs">
                {revoked ? 'Revoked' : peerTrustLabel(peer.trustTier)}
              </Badge>
            </div>

            <p className="text-muted-foreground text-xs break-all">{peer.memoryEndpoint}</p>

            {revoked ? (
              <p className="text-muted-foreground text-xs">
                You ended this link. Their box can no longer ask yours anything.
              </p>
            ) : (
              <>
                <p className="text-muted-foreground text-xs">{peerTrustCeilingNote(peer.trustTier)}</p>

                <div
                  role="group"
                  aria-label={`Trust tier for ${peer.peerHandle}`}
                  className="flex flex-wrap gap-1"
                >
                  {PEER_TRUST_TIERS.map((tier) => (
                    <Button
                      key={tier}
                      size="sm"
                      variant={peer.trustTier === tier ? 'default' : 'outline'}
                      aria-pressed={peer.trustTier === tier}
                      disabled={busy}
                      onClick={() => requestTier(peer, tier)}
                    >
                      {peerTrustLabel(tier)}
                    </Button>
                  ))}
                </div>

                {pending ? (
                  <Card
                    className="flex flex-col gap-2 p-3"
                    role="alertdialog"
                    aria-label="Confirm wider trust"
                  >
                    <p className="text-sm">
                      {peerTrustLabel(pending)} lets {peer.peerHandle} be told more than they can be told now,
                      on every future ask — including ones you have already granted.
                    </p>
                    <p className="text-muted-foreground text-xs">{peerTrustCeilingNote(pending)}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(null);
                          onChangeTier(peer.id, pending);
                        }}
                      >
                        Yes, trust them more
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </div>
                  </Card>
                ) : null}

                <div>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRevoke(peer.id)}>
                    End this link
                  </Button>
                </div>
              </>
            )}
          </Card>
        );
      })}

      <AddPeerForm busy={busy} onAdd={onAdd} />
    </div>
  );
}

/**
 * Add a peer.
 *
 * NO TIER FIELD, on purpose. `createPeerLink` defaults an omitted tier to
 * `stranger` — the narrowest — and that default only holds if the form declines
 * to override it. Adding somebody and deciding how far to trust them are two
 * decisions, and a form that collects both in one gesture reliably collects the
 * second one carelessly. The copy says so out loud so the absence reads as a
 * choice rather than as a missing field.
 *
 * The endpoint is typed in rather than looked up because directory resolution
 * needs a CI-Portal token nothing puts in the request context yet — a lookup
 * that pretended to verify an identity it never checked would be worse than a
 * manual step.
 */
function AddPeerForm({ busy, onAdd }: { busy: boolean; onAdd: Props['onAdd'] }) {
  const [peerHandle, setPeerHandle] = useState('');
  const [memoryEndpoint, setMemoryEndpoint] = useState('');
  const [displayName, setDisplayName] = useState('');

  const canAdd = peerHandle.trim().length > 0 && memoryEndpoint.trim().length > 0 && !busy;

  return (
    <Card className="flex flex-col gap-2 p-4">
      <p className="font-medium">Link someone new</p>

      <label className="flex flex-col gap-1">
        <span className="text-sm">Their handle</span>
        <Input
          value={peerHandle}
          placeholder="ada"
          disabled={busy}
          onChange={(event) => setPeerHandle(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm">Their Companion’s address</span>
        <Input
          value={memoryEndpoint}
          placeholder="https://ada.example/api/peer"
          disabled={busy}
          onChange={(event) => setMemoryEndpoint(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm">What you want to call them (optional)</span>
        <Input value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} />
      </label>

      <p className="text-muted-foreground text-xs">
        New links start as <strong>Stranger</strong> — the narrowest tier, where answers are yes-or-no at most
        and your location is never disclosed. Raise it afterwards, deliberately.
      </p>

      <div>
        <Button
          disabled={!canAdd}
          onClick={() => {
            onAdd({
              peerHandle: peerHandle.trim(),
              memoryEndpoint: memoryEndpoint.trim(),
              displayName: displayName.trim() || undefined,
            });
            setPeerHandle('');
            setMemoryEndpoint('');
            setDisplayName('');
          }}
        >
          Add peer
        </Button>
      </div>
    </Card>
  );
}
