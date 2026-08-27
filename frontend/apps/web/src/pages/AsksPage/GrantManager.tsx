import { useState } from 'react';

import { Badge, Button, Card, Input } from '@ci/shadcn';

import { PersonAvatar } from '@/components/PersonAvatar';

import { grantUsageLine, type GrantMode, grantModeBadge, grantModeLabel } from './askPresentation';

export interface GrantRow {
  id: string;
  /** Data class or ask type this grant covers, in owner-facing words. */
  label: string;
  mode: GrantMode;
  /** Optional scope note, e.g. "digest only · no location". */
  note?: string;
  /** ISO date this grant stops applying, if any. */
  expiresAt?: string | null;
  /**
   * ISO date the owner withdrew this grant, if they have. A row carrying one is
   * NOT in force, whatever `mode` says.
   */
  revokedAt?: string | null;
  /**
   * The server's own liveness verdict (`isGrantActive`).
   *
   * Read rather than re-derived from the two dates above. A second copy of a
   * liveness rule on the client is a rule that can disagree with the one that
   * actually gates disclosure, and the direction it would disagree in is the
   * bad one: a grant this page called live while the server called it lapsed is
   * merely confusing, but a grant this page called lapsed while the server
   * still honours it is the owner believing they are safe when they are not.
   */
  active?: boolean;
  /**
   * How often a disclosure has actually cited this grant, and when last.
   *
   * DORMANT IS A STATE. The matrix showed what the owner allowed and never
   * whether anything came of it, so a grant firing daily and one that has never
   * matched looked identical — and they call for opposite actions.
   */
  useCount?: number;
  lastUsedAt?: string | null;
}

export interface GranteeGroup {
  id: string;
  name: string;
  /** The grantee's photo, when it's a peer whose link resolved one. Null renders initials. */
  avatarUrl?: string | null;
  tier: string;
  grants: GrantRow[];
}

interface Props {
  groups: GranteeGroup[];
  /** Posture for anyone without an explicit grant. Always review or block. */
  defaultMode?: Extract<GrantMode, 'review' | 'block'>;
  onChangeMode?: (grantId: string, mode: GrantMode) => void;
  /** Set (or move) the date a grant stops applying. ISO 8601, always future. */
  onSetExpiry?: (grantId: string, expiresAtIso: string) => void;
  onRevoke?: (grantId: string) => void;
  onAddGrant?: () => void;
  onOpenHistory?: () => void;
  /**
   * One sentence from the container about what this matrix cannot show, e.g. a
   * liveness field the wire does not carry yet. Rendered where the owner reads
   * the grants, not in a comment nobody sees.
   */
  caveat?: string;
  busy?: boolean;
}

const MODES: GrantMode[] = ['auto', 'review', 'block'];

/**
 * "Who can ask me what" — the standing-consent matrix.
 *
 * Every grant is one row with three mutually exclusive states, and the fallback
 * for everyone else is stated explicitly rather than left implicit: review is
 * the floor, so a person who has never been granted anything can still only ever
 * reach the owner's inbox. Expiry is shown inline because a grant the owner has
 * forgotten about is the main way standing consent goes wrong.
 *
 * ═══ INERT CONTROLS ARE WORSE THAN ABSENT ONES ═══
 *
 * The three mode buttons render whether or not `onChangeMode` is wired, and for
 * the whole life of this page it was not: tapping "Blocked" moved nothing,
 * persisted nothing, and left a button looking pressed. On a consent surface
 * that is the most dangerous possible failure — the owner believes they have
 * revoked access they still grant. So when no handler is supplied the buttons
 * are `disabled` and the reason is printed beside them. The current mode stays
 * legible either way, because the badge on the row carries it in words.
 *
 * The page now WIRES that handler (`updateAskGrant` has been on the schema the
 * whole time; nothing selected it), so the disabled branch is a fallback rather
 * than the normal case — and the sentence it prints is only ever true when it
 * shows.
 *
 * ═══ ONE DIRECTION ASKS TWICE ═══
 *
 * Moving a grant to "Answers automatically" is the only edit on this card that
 * makes something be disclosed WITHOUT THE OWNER PRESENT, so it takes a second,
 * explicit tap. The other two do not, and that asymmetry is on purpose:
 * "Blocked" and "Ask me first" both end with less leaving the box, and putting a
 * confirmation in front of them would slow down the gesture you most want to be
 * instant. Block → Ask-me-first is likewise unconfirmed: it stops an automatic
 * REFUSAL, which discloses nothing by itself — every such ask still has to be
 * approved by hand.
 */
export function GrantManager({
  groups,
  defaultMode = 'review',
  onChangeMode,
  onSetExpiry,
  onRevoke,
  onAddGrant,
  onOpenHistory,
  caveat,
  busy = false,
}: Props) {
  const canChangeMode = onChangeMode != null;
  const [confirmingAuto, setConfirmingAuto] = useState<string | null>(null);

  const requestMode = (grantId: string, current: GrantMode, next: GrantMode) => {
    if (next === current) {
      return;
    }

    if (next === 'auto') {
      setConfirmingAuto(grantId);

      return;
    }

    setConfirmingAuto(null);
    onChangeMode?.(grantId, next);
  };

  return (
    <div className="flex flex-col gap-3">
      {canChangeMode && caveat == null ? null : (
        <Card className="flex flex-col gap-1 p-3 text-xs">
          {canChangeMode ? null : (
            <p>
              Changing a grant’s mode isn’t available yet. To change one, revoke it and create a replacement —
              revoking works.
            </p>
          )}
          {caveat ? <p className="text-muted-foreground">{caveat}</p> : null}
        </Card>
      )}

      {groups.map((group) => (
        <Card key={group.id} className="flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <PersonAvatar name={group.name} avatarUrl={group.avatarUrl} size="xs" />
            <span className="font-medium">{group.name}</span>
            <Badge variant="secondary" className="text-xs">
              {group.tier}
            </Badge>
          </div>

          <ul className="flex flex-col divide-y">
            {group.grants.map((grant) => {
              const badge = grantModeBadge(grant.mode);
              // A revoked grant is history, not consent. Its mode still describes
              // what it USED to allow, so the row keeps the label but must never
              // present it as something currently in force.
              const revoked = grant.revokedAt != null;
              // Lapsed is a THIRD state, not a flavour of revoked: nobody
              // withdrew it, it simply ran out. Saying "revoked" would credit the
              // owner with a decision they never made.
              const lapsed = !revoked && grant.active === false;
              const inForce = !revoked && !lapsed;

              return (
                <li key={grant.id} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{grant.label}</p>
                    {grant.note ? (
                      <p className="text-muted-foreground truncate text-xs">{grant.note}</p>
                    ) : null}
                    {/* Whether it has ever fired. Muted: "Never used" is the
                        ordinary state of a grant written in advance, which is
                        what standing consent is for. */}
                    <span className="text-muted-foreground text-xs">
                      {grantUsageLine({ useCount: grant.useCount ?? 0, lastUsedAt: grant.lastUsedAt })}
                    </span>
                    {grant.expiresAt ? (
                      <p className="text-muted-foreground text-xs">
                        {lapsed ? 'Lapsed' : 'Expires'} {formatDate(grant.expiresAt)}
                      </p>
                    ) : inForce ? (
                      // Said out loud. An owner who sees no date reads "I must
                      // have set one" far more often than "this never ends".
                      <p className="text-muted-foreground text-xs">No end date — this does not expire.</p>
                    ) : null}
                    {revoked ? (
                      <p className="text-muted-foreground text-xs">
                        Revoked {formatDate(grant.revokedAt)} — no longer in force
                      </p>
                    ) : null}
                    {lapsed ? (
                      <p className="text-muted-foreground text-xs">Ran out on its own — no longer in force</p>
                    ) : null}
                  </div>

                  {/* The badge repeats the mode in words so the state never
                      depends on colour alone (WCAG 1.4.1). */}
                  <Badge variant={inForce ? badge.variant : 'outline'} className="text-xs">
                    {revoked ? 'Revoked' : lapsed ? 'Lapsed' : badge.label}
                  </Badge>

                  {inForce ? (
                    <div className="flex w-full flex-col gap-2">
                      <div
                        role="group"
                        aria-label={`Consent for ${grant.label}`}
                        className="flex flex-wrap gap-1"
                      >
                        {MODES.map((mode) => (
                          <Button
                            key={mode}
                            size="sm"
                            variant={grant.mode === mode ? 'default' : 'outline'}
                            aria-pressed={grant.mode === mode}
                            disabled={!canChangeMode || busy}
                            onClick={() => requestMode(grant.id, grant.mode, mode)}
                          >
                            {grantModeLabel(mode)}
                          </Button>
                        ))}
                        {onRevoke ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => onRevoke(grant.id)}
                          >
                            Revoke
                          </Button>
                        ) : null}
                      </div>

                      {confirmingAuto === grant.id ? (
                        <Card
                          className="flex flex-col gap-2 p-3"
                          role="alertdialog"
                          aria-label="Confirm automatic answering"
                        >
                          <p className="text-sm">
                            Answering automatically means their future asks are answered without reaching you.
                            You will see them afterwards under “What I’ve shared”, not before.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setConfirmingAuto(null);
                                onChangeMode?.(grant.id, 'auto');
                              }}
                            >
                              Yes, answer automatically
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmingAuto(null)}>
                              Cancel
                            </Button>
                          </div>
                        </Card>
                      ) : null}

                      {onSetExpiry ? <ExpiryControl grant={grant} busy={busy} onSet={onSetExpiry} /> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      <Card className="flex flex-wrap items-center gap-2 p-4">
        <span className="text-sm">Everyone else</span>
        <Badge variant="secondary" className="text-xs">
          {grantModeBadge(defaultMode).label}
        </Badge>
        <span className="text-muted-foreground text-xs">Nothing is answered without you, ever.</span>
      </Card>

      <div className="flex flex-wrap gap-2">
        {onAddGrant ? (
          <Button variant="outline" size="sm" onClick={onAddGrant}>
            New grant
          </Button>
        ) : null}
        {onOpenHistory ? (
          <Button variant="ghost" size="sm" onClick={onOpenHistory}>
            What I’ve shared
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Give a grant an end date.
 *
 * Only SETTING and MOVING a date is offered; there is no "never expires" button.
 * That omission is the safety property, not an oversight: `updateAskGrant`
 * accepts `clearExpiry`, and clearing an expiry is the one edit on this whole
 * card that makes a grant permanent. Nothing here needs it, so this page does
 * not select it — an owner who truly wants an unbounded grant can revoke and
 * write one, which at least leaves both acts on the record.
 *
 * A date-only `<input type="date">` is submitted as END of that day in the
 * owner's own timezone. Interpreting a bare `YYYY-MM-DD` as UTC midnight —
 * which is what `new Date('2026-09-01')` does — would silently cut a grant short
 * by up to a day for anybody east of Greenwich, and the direction of that error
 * matters less than the fact that the owner would not have chosen it.
 */
function ExpiryControl({
  grant,
  busy,
  onSet,
}: {
  grant: GrantRow;
  busy: boolean;
  onSet: (grantId: string, expiresAtIso: string) => void;
}) {
  const [value, setValue] = useState('');

  const submit = () => {
    const iso = endOfLocalDay(value);

    if (iso == null) {
      return;
    }

    onSet(grant.id, iso);
    setValue('');
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          {grant.expiresAt ? 'Move the end date' : 'Give this an end date'}
        </span>
        <Input
          type="date"
          value={value}
          disabled={busy}
          aria-label={`End date for ${grant.label}`}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <Button size="sm" variant="outline" disabled={busy || endOfLocalDay(value) == null} onClick={submit}>
        Set
      </Button>
    </div>
  );
}

/**
 * `YYYY-MM-DD` → the last instant of that day, locally, as ISO.
 *
 * Returns null for anything unparseable AND for anything already past:
 * `GrantService.supersede` calls `assertFutureExpiry`, so a past date is a 400,
 * and letting the button stay enabled for one is an error the owner has to read
 * a server message to understand.
 */
function endOfLocalDay(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const at = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999);

  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
    return null;
  }

  return at.toISOString();
}

/** An ISO instant as a date the owner can compare against a memory. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }

  const at = new Date(iso);

  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString(undefined, { dateStyle: 'medium' });
}
