import { Badge, Button, Card } from '@ci/shadcn';
import { ChevronRight, TrendingUp } from '@ci/shadcn/icons';

import { PersonAvatar } from '@/components/PersonAvatar';

import {
  accelerationNote,
  activityLine,
  isUnattributed,
  lastActiveLine,
  magnitudeLine,
  relationshipLabel,
  truncationNote,
  type RelationshipSummary,
} from './relationshipPresentation';

interface Props {
  summaries: readonly RelationshipSummary[];
  /** The recency window the numbers were folded over, for the copy. */
  windowDays: number;
  /** True when the fold ran over a capped read — the totals are then floors. */
  truncated: boolean;
  /** How many rows the fold actually saw, for the truncation note. */
  countedRows: number;
  onOpen: (summary: RelationshipSummary) => void;
}

/**
 * "What I've shared", indexed BY PERSON.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * The flat history answers "what happened at 14:07 on Tuesday". Nobody arrives
 * with that question. They arrive with *"what has Ana been getting?"* — and a
 * standing grant answering twice a day writes some seven hundred rows a year,
 * so answering it from the flat list means holding a running tally in your head
 * while you scroll. The list is at its LEAST usable exactly when it has
 * accumulated the most to say, which is the opposite of what an audit trail is
 * for.
 *
 * Pagination would not have fixed that, because the unit was wrong. This is the
 * index; the flat list, filtered to one counterparty, is the drill-in.
 *
 * ═══ WHAT EACH ROW LEADS WITH, AND WHY ═══
 *
 * `autoAnswered` first, named as the thing that happened without them. That is
 * the outcome an owner might want to go and stop, and the only one they cannot
 * discover any other way — a decision they made themselves, they remember
 * making.
 *
 * Then MAGNITUDE, not ask count: "14 asks" and "213 items" are different facts
 * and only the second describes what the other person now holds.
 *
 * ═══ WHAT THIS DELIBERATELY DOES NOT DO ═══
 *
 * It does not judge. {@link accelerationNote} states a fact — *"80% of
 * everything they have ever received arrived in this window"* — and stops
 * there. There is no enforced disclosure budget behind it yet (CI-Server
 * #2364), and a threshold rendered here would be a number with nothing behind
 * it: the "protection that is not there" this domain has been burned by before.
 *
 * It also does not put a lock on a row. The lock is a claim about ONE
 * disclosure's consent basis and channel; a relationship spans many, which may
 * differ. Summarizing them into a single lock would assert something no row
 * says.
 */
export function DisclosureRelationships({ summaries, windowDays, truncated, countedRows, onOpen }: Props) {
  const note = truncationNote(truncated, countedRows);

  return (
    <div className="flex flex-col gap-3">
      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}

      <ul className="flex flex-col gap-3">
        {summaries.map((summary) => {
          const label = relationshipLabel(summary);
          const acceleration = accelerationNote(summary);
          const unattributed = isUnattributed(summary);

          return (
            <li key={summary.key}>
              <Card className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {/* No avatar for the unattributed bucket: it is not a person,
                      and giving it a face would imply it was one. */}
                  {unattributed ? null : <PersonAvatar name={label} avatarUrl={null} size="xs" />}
                  <span className="font-medium">{label}</span>

                  {summary.autoAnswered > 0 ? (
                    // Text, never colour alone (WCAG 1.4.1) — and the phrase
                    // names the property, not the mechanism.
                    <Badge variant="secondary" className="text-xs">
                      Answers without asking you
                    </Badge>
                  ) : null}

                  <span className="text-muted-foreground ml-auto text-xs">
                    {lastActiveLine(summary.lastAt)}
                  </span>
                </div>

                <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
                  <p>{activityLine(summary)}</p>
                  <p>{magnitudeLine(summary, windowDays)}</p>
                  {acceleration ? (
                    <p className="flex items-center gap-1.5">
                      <TrendingUp className="size-3 shrink-0" aria-hidden />
                      {acceleration}
                    </p>
                  ) : null}
                  {unattributed ? (
                    <p>
                      These disclosures no longer name who received them — the account or peer link was
                      removed. They are kept so the totals stay honest.
                    </p>
                  ) : null}
                </div>

                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpen(summary)}
                    aria-label={`See all ${summary.total} disclosures for ${label}`}
                  >
                    See all {summary.total}
                    <ChevronRight className="size-3" aria-hidden />
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
