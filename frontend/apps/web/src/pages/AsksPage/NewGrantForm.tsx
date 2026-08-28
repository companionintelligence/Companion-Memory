import { useState } from 'react';

import { Button, Card, Input } from '@ci/shadcn';

import { type GrantMode, grantModeLabel } from './askPresentation';
import { COMPOSER_SHAPES } from './composeRecipients';

export interface NewGrant {
  granteeId: string;
  queryType: string;
  dataClass?: string;
  mode: GrantMode;
}

interface Props {
  /** The owner's own ask address, shown so they can hand it to the other person. */
  myAddress?: string | null;
  busy?: boolean;
  onCreate: (grant: NewGrant) => void;
  onCancel: () => void;
}

/**
 * Write the first standing grant — and, on a box where nobody has asked anybody
 * anything yet, the only way to make the composer non-empty.
 *
 * ═══ WHY THIS TAKES A PASTED ID AND NOT A PERSON PICKER ═══
 *
 * There is no user-search endpoint on this appliance, and that is deliberate:
 * `composeRecipients` documents at length that adding one would hand any
 * signed-in account a roster of everybody on a box that holds one person's
 * entire life. This form does not add one either. It takes the grantee's ask
 * address — the opaque `GlobalUID` the API already emits as `me.id` — which the
 * grantee has to have given the owner out of band.
 *
 * That is the same trust gesture as handing someone your phone number, and it
 * is enumeration-proof in the direction that matters: you can only ever read
 * YOUR OWN address (shown above the field), so nothing here lets one account
 * discover another. An email box would be friendlier and would need exactly the
 * lookup the roster ban exists to prevent, so it is not offered.
 *
 * ═══ THE MODE DEFAULT IS THE SAFE ONE ═══
 *
 * `review` — every ask still reaches the owner's inbox, the grant only means
 * "this person is allowed to ask". `auto` is the one setting on this page that
 * discloses without the owner present, so it is selectable but never the
 * default, and `GrantManager` makes moving an EXISTING grant to it take a second
 * confirming tap. Choosing it here is already explicit, so it is not
 * double-confirmed; what matters is that a distracted owner cannot arrive at it
 * by pressing Create.
 */
export function NewGrantForm({ myAddress, busy = false, onCreate, onCancel }: Props) {
  const [granteeId, setGranteeId] = useState('');
  const [shapeId, setShapeId] = useState(COMPOSER_SHAPES[0]?.id ?? '');
  const [mode, setMode] = useState<GrantMode>('review');
  const [copied, setCopied] = useState(false);

  const shape = COMPOSER_SHAPES.find((candidate) => candidate.id === shapeId);
  const trimmed = granteeId.trim();
  const canCreate = trimmed.length > 0 && shape != null && !busy;

  const copyAddress = () => {
    if (!myAddress) {
      return;
    }

    void navigator.clipboard?.writeText(myAddress).then(
      () => setCopied(true),
      // A clipboard the browser refused is not worth an error banner on a
      // consent surface — the address is selectable text either way.
      () => undefined,
    );
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Let someone ask you</h3>
        <p className="text-muted-foreground text-xs">
          A grant says who may ask, and what about. It does not answer anything on its own unless you
          choose “Answers automatically”.
        </p>
      </div>

      {myAddress ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            Your ask address — give this to someone so they can grant you back
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs">
              {myAddress}
            </code>
            <Button variant="outline" size="sm" onClick={copyAddress}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-sm">Their ask address</span>
        <Input
          value={granteeId}
          placeholder="Paste the address they gave you"
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setGranteeId(event.target.value)}
        />
        <span className="text-muted-foreground text-xs">
          Nobody is searchable on this box. They have to hand you their address.
        </span>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-sm">What may they ask about?</span>
        <div role="radiogroup" aria-label="What may they ask about" className="flex flex-wrap gap-2">
          {COMPOSER_SHAPES.map((candidate) => (
            <Button
              key={candidate.id}
              size="sm"
              variant={candidate.id === shapeId ? 'default' : 'outline'}
              role="radio"
              aria-checked={candidate.id === shapeId}
              disabled={busy}
              onClick={() => setShapeId(candidate.id)}
            >
              {candidate.label}
            </Button>
          ))}
        </div>
        {/* The same ceiling sentence the composer shows the asker. A grant and
            an ask are matched on (grantee, queryType), so the owner has to be
            reading the same vocabulary the asker picks from — otherwise a grant
            can name a kind of question nobody can send. */}
        {shape ? <p className="text-muted-foreground text-xs">{shape.ceiling}</p> : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-sm">And then?</span>
        <div role="radiogroup" aria-label="Grant mode" className="flex flex-wrap gap-2">
          {(['review', 'auto', 'block'] as const).map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant={candidate === mode ? 'default' : 'outline'}
              role="radio"
              aria-checked={candidate === mode}
              disabled={busy}
              onClick={() => setMode(candidate)}
            >
              {grantModeLabel(candidate)}
            </Button>
          ))}
        </div>
        {mode === 'auto' ? (
          <p className="text-destructive text-xs">
            Asks of this kind will be answered without you present.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!canCreate}
          onClick={() => {
            if (!shape) {
              return;
            }

            onCreate({
              granteeId: trimmed,
              queryType: shape.queryType,
              dataClass: shape.dataClass,
              mode,
            });
          }}
        >
          Create grant
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
