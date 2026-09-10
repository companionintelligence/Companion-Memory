import { Badge, Button, Card } from '@ci/shadcn';

import type { ApprovalReason, PendingApproval } from './useApprovals';

/**
 * What the appliance refused to do unasked, in the appliance's words.
 *
 * Keyed on `ToolGateReason`, which the server derives from the intent's DECLARED
 * privacy label — not from anything the agent wrote. That is the whole point: a
 * consent dialog composed by the party asking for consent is not a consent
 * dialog, and an agent that could phrase its own approval prompt would eventually
 * phrase a persuasive one.
 *
 * An unrecognised reason falls back to the conservative sentence rather than to
 * the raw enum. A new gate reason should read as "something serious" before
 * anyone gets round to writing its copy, not as a slug.
 */
const REASON_COPY: Record<ApprovalReason, string> = {
  'destructive-requires-confirmation': 'This removes data. It cannot be undone from here.',
  'external-leaves-appliance': 'This sends data to a third party, off your appliance.',
  'confirmation-required': 'This is irreversible, and an installed app asked for it.',
  'not-local-capable': 'This needs the appliance, and cannot be answered on-device.',
  'capability-insufficient': 'This caller is not permitted to run it.',
  allowed: 'This is waiting for you.',
};

function reasonCopy(reason: ApprovalReason): string {
  return REASON_COPY[reason] ?? 'This is irreversible and needs your say-so.';
}

/**
 * Turn an api-key name into something an owner can act on.
 *
 * The row stores the fact (`app:ci-openclaw:ci-marketplace`); this is the
 * presentation half. A deliberately small map with a readable fallback rather
 * than an import from the harness registry, which lives in another domain the
 * backend may not reach into and which the frontend does not receive.
 *
 * The fallback matters more than the map: a NEW installed app must still be
 * nameable on a card the day it ships, and "app:ci-something:marketplace" is a
 * worse label than "ci-something" but a far better one than nothing.
 */
const APP_LABELS: Record<string, string> = {
  'ci-openclaw': 'OpenClaw',
  'ci-hermes': 'Hermes',
};

export function appLabel(principalName: string | null): string | null {
  if (!principalName) {
    return null;
  }

  // `app:<slug>:<marketplace>` — take the slug.
  const slug = principalName.startsWith('app:') ? principalName.slice(4).split(':')[0] : null;

  if (!slug) {
    return principalName;
  }

  return APP_LABELS[slug] ?? slug;
}

interface Props {
  action: PendingApproval;
  onAnswer: (id: string, verdict: 'approve' | 'decline') => void;
  busy?: boolean;
}

export function ApprovalCard({ action, onAnswer, busy = false }: Props) {
  const expires = action.expiresAt ? new Date(action.expiresAt) : null;

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid={`approval-${action.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          {/* The intent id, not a prose summary — it is the thing that will run. */}
          <code className="text-sm font-semibold">{action.intent}</code>
          <p className="text-sm text-muted-foreground">{reasonCopy(action.reason)}</p>
        </div>
        {/*
          WHO asked, when an app did. `actor` alone ("full") would ask the owner
          to authorise an anonymous caller holding broad authority, which is the
          least answerable form of the question. The capability rides along as a
          title so it is still inspectable.
        */}
        <Badge variant="outline" title={`capability: ${action.actor}`}>
          {appLabel(action.principalName) ?? 'You'}
        </Badge>
      </div>

      {/*
        The exact arguments. `ci.pending_actions` stores `input` as jsonb — unlike
        the invocation ledger, which deliberately stores no arguments at all — so
        this is the one surface that can show WHAT would happen rather than only
        that something would. Approving a `messaging.send` without seeing the
        recipient and the body would be consent to a category, not to an act.
      */}
      <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">
        {JSON.stringify(action.input, null, 2)}
      </pre>

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {expires ? `Expires ${expires.toLocaleString()}` : 'No expiry'}
        </span>
        <div className="flex gap-2">
          {/* Decline first, and not styled as the destructive action: the
              destructive thing here is approving. */}
          <Button variant="outline" disabled={busy} onClick={() => onAnswer(action.id, 'decline')}>
            Decline
          </Button>
          <Button disabled={busy} onClick={() => onAnswer(action.id, 'approve')}>
            Approve
          </Button>
        </div>
      </div>
    </Card>
  );
}
