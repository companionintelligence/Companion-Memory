import { useState } from 'react';

import { Badge, Button, Card, Input } from '@ci/shadcn';
import { Zap } from '@ci/shadcn/icons';

import { PersonAvatar } from '@/components/PersonAvatar';

/**
 * The longest prompt this composer will send.
 *
 * Matched to `askQuerySchema`'s `prompt: z.string().max(500)` — the bound the
 * peer protocol enforces. The GraphQL `AskQueryInput` does NOT currently
 * enforce it (the column is jsonb), so this is a courtesy limit, not a
 * guarantee: it stops an owner accidentally sending something a peer box would
 * reject, and it is not a substitute for the render-side bound in
 * promptSafety.ts, which exists to protect whoever READS this text.
 */
const MAX_PROMPT = 500;

export interface ComposerRecipient {
  /** The opaque user id `createAsk` is addressed to. */
  id: string;
  name: string;
  /** A photo, when one is known. Null (the common case here) renders initials. */
  avatarUrl?: string | null;
  /** What can truthfully be said about them, in the container's words. */
  tier: string;
  /** Why they are offered here at all — see AsksPage's recipient derivation. */
  why: string;
  /** Whether a standing grant would answer without interrupting them. */
  autoAnswers?: boolean;
}

export interface UnreachableRecipient {
  id: string;
  name: string;
  avatarUrl?: string | null;
  tier: string;
  /** Plain-language reason this person cannot be asked from here yet. */
  reason: string;
}

export interface ComposerShape {
  id: string;
  /** How the owner picks it: the kind of question, in their words. */
  label: string;
  /** The literal `queryType` that goes on the wire. */
  queryType: string;
  /** The literal `dataClass` that goes on the wire, when there is one. */
  dataClass?: string;
  /** What the responder's box can answer at most, given this shape. */
  ceiling: string;
}

interface Props {
  recipients: readonly ComposerRecipient[];
  /**
   * People the owner has a relationship with who nonetheless cannot be asked
   * from this page. Rendered, not hidden — see the component docstring.
   */
  unreachable?: readonly UnreachableRecipient[];
  shapes: readonly ComposerShape[];
  onSend: (ask: { responderId: string; queryType: string; dataClass?: string; prompt: string }) => void;
  busy?: boolean;
}

/**
 * Compose an ask.
 *
 * ═══ WHAT MADE THIS UNREACHABLE, AND WHAT MAKES IT REACHABLE NOW ═══
 *
 * This component shipped with the trust-graph work and was imported by nothing
 * but its own story, because it needed one thing the client could not produce:
 * somebody to address the ask to. `createAsk(input.responderId)` takes an opaque
 * user id, and there is no query on this schema that lists users — deliberately,
 * because such a query would be an enumeration surface over everybody on the
 * appliance, on a box that holds one person's whole life.
 *
 * The way out is not to add that query. It is to notice that the owner's OWN
 * records already contain the ids of the people they have a relationship with:
 * anybody who has asked them something, anybody they have asked, and anybody
 * they have written a standing grant for. See `composeRecipients` in
 * AsksPage.tsx. Every id offered here is one the owner is already looking at
 * somewhere else on this page, so the picker discloses nothing new.
 *
 * ═══ WHY UNREACHABLE PEOPLE ARE SHOWN ═══
 *
 * A linked PEER cannot be addressed by `createAsk` at all — a peer link carries
 * no local user id, and the federated path (`sendPeerAsk`) requires a
 * Portal-issued access token that this box explicitly never mints or stores. An
 * owner who has just linked somebody and comes here to ask them a question needs
 * to be told that, in those words. Omitting them silently would be the same
 * class of defect as the empty states this page has spent its life fixing: an
 * absence rendered as though it were a fact.
 *
 * ═══ THE PREVIEW IS THE CONTRACT ═══
 *
 * The composer's job is honesty in the other direction too: the structured
 * request that will actually be sent is shown back before sending, field for
 * field. That preview IS the wire format — `{queryType, dataClass, prompt}` is
 * the whole of `AskQueryInput` — so there is no hidden widening between what the
 * asker sees here and what the responder is asked to consent to. If a field is
 * ever added to that input, it has to be added here or this comment becomes a
 * lie.
 */
export function AskComposer({ recipients, unreachable = [], shapes, onSend, busy = false }: Props) {
  const [recipientId, setRecipientId] = useState<string | null>(recipients[0]?.id ?? null);
  const [shapeId, setShapeId] = useState<string>(shapes[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');

  const recipient = recipients.find((candidate) => candidate.id === recipientId) ?? null;
  const shape = shapes.find((candidate) => candidate.id === shapeId) ?? shapes[0];
  const trimmed = prompt.trim();
  const canSend = recipient != null && shape != null && trimmed.length > 0 && !busy;

  if (recipients.length === 0 && unreachable.length === 0) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <p className="font-medium">There is nobody to ask yet.</p>
        <p className="text-muted-foreground text-sm">
          You can ask someone once you share a Companion with them, or once they have asked you something.
          This page will not look anybody up for you — searching everyone on this box would be a way for one
          account to enumerate the rest.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-sm">Who are you asking?</span>
        <div role="radiogroup" aria-label="Recipient" className="flex flex-wrap gap-2">
          {recipients.map((candidate) => (
            <Button
              key={candidate.id}
              size="sm"
              variant={candidate.id === recipientId ? 'default' : 'outline'}
              role="radio"
              aria-checked={candidate.id === recipientId}
              disabled={busy}
              onClick={() => setRecipientId(candidate.id)}
              // A little left padding on top of the button's own inset, so the
              // avatar doesn't sit flush against the pill's edge.
              className="gap-1.5 pl-1.5"
            >
              {/* Pairing even an opaque, truncated-id label with a real avatar
                  is what stops it reading as corrupted text — see
                  composeRecipients.ts. */}
              <PersonAvatar name={candidate.name} avatarUrl={candidate.avatarUrl} size="xs" />
              {candidate.name}
            </Button>
          ))}
        </div>
      </div>

      {recipient ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">To</span>
          <PersonAvatar name={recipient.name} avatarUrl={recipient.avatarUrl} size="xs" />
          <span className="font-medium">{recipient.name}</span>
          <Badge variant="secondary" className="text-xs">
            {recipient.tier}
          </Badge>
          <span className="text-muted-foreground text-xs">{recipient.why}</span>
          {recipient.autoAnswers ? (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <Zap aria-hidden className="size-3.5" />
              Answers instantly under a standing grant
            </span>
          ) : null}
        </div>
      ) : null}

      {unreachable.length > 0 ? (
        <Card className="flex flex-col gap-1 p-3 text-xs">
          <p className="font-medium">People you are linked to but cannot ask from here</p>
          {unreachable.map((peer) => (
            <p key={peer.id} className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <PersonAvatar name={peer.name} avatarUrl={peer.avatarUrl} size="xs" />
              <span className="text-foreground">{peer.name}</span>
              <span>
                ({peer.tier}) — {peer.reason}
              </span>
            </p>
          ))}
        </Card>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-sm">What kind of question is it?</span>
        <div role="radiogroup" aria-label="Kind of question" className="flex flex-wrap gap-2">
          {shapes.map((candidate) => (
            <Button
              key={candidate.id}
              size="sm"
              variant={candidate.id === shape?.id ? 'default' : 'outline'}
              role="radio"
              aria-checked={candidate.id === shape?.id}
              disabled={busy}
              onClick={() => setShapeId(candidate.id)}
            >
              {candidate.label}
            </Button>
          ))}
        </div>
        {/* The ceiling, stated where the choice is made. The kind of question
            decides the SHAPE of the answer the responder's box can produce
            (`inferAnswerForm` reads `queryType`), so picking one here is
            already a disclosure decision — just one made by the asker. */}
        {shape ? <p className="text-muted-foreground text-xs">{shape.ceiling}</p> : null}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm">Your question</span>
        <Input
          value={prompt}
          maxLength={MAX_PROMPT}
          placeholder="Do you have photos of us from the lake trip?"
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>

      {recipient && shape ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            {recipient.name} will see exactly this, and nothing else
          </span>
          <dl className="bg-muted flex flex-col gap-1 rounded-md px-3 py-2 text-xs">
            {[
              { label: 'queryType', value: shape.queryType },
              { label: 'dataClass', value: shape.dataClass ?? '(none)' },
              { label: 'prompt', value: trimmed || '(empty)' },
            ].map((row) => (
              <div key={row.label} className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">{row.label}</dt>
                <dd className="min-w-0 flex-1 break-words">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Their Companion answers only what {recipient?.name ?? 'they'} allows — and you will not be told
        whether a person read this or a standing rule answered it.
      </p>

      <div>
        <Button
          onClick={() => {
            if (!recipient || !shape) {
              return;
            }

            onSend({
              responderId: recipient.id,
              queryType: shape.queryType,
              dataClass: shape.dataClass,
              prompt: trimmed,
            });
            setPrompt('');
          }}
          disabled={!canSend}
        >
          Send ask
        </Button>
      </div>
    </Card>
  );
}
