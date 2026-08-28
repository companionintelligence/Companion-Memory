import { Badge, Button, Card } from '@ci/shadcn';

import { type AnswerReview, provenanceLine, withheldNote } from './askPresentation';

interface Props {
  responderName: string;
  /** The templated, non-leaking summary the responder's box produced. */
  summary: string;
  /** Disclosed item references (retrieval form only). */
  items?: { id: string; type: string; label: string }[];
  disclosedCount: number;
  withheldCount: number;
  /** Whether a human reviewed this — see {@link AnswerReview} for the third value. */
  review: AnswerReview;
  /**
   * True when the viewer's copy of this answer has its magnitudes zeroed.
   *
   * `AskAnswerType.toType` reports `disclosedCount: 0` and `withheldCount: 0` to
   * the ASKER for every non-itemizing form, because a "yes/no" answer that also
   * carries "9" hands over a precise magnitude — and, by varying the prompt, a
   * count oracle over the responder's corpus. That masking is correct, and it
   * makes a zero on this card ambiguous: it means either "nothing" or "you are
   * not being told". Rendering the two the same way turns a deliberate
   * withholding into a false reassurance, so the caller says which it is.
   */
  countsWithheld?: boolean;
  /**
   * The rule the disclosure rested on. NULL for the asker — it names one of the
   * responder's own grant rows, so it is responder-only by design.
   */
  consentBasis?: string | null;
  onSave?: () => void;
  onThank?: () => void;
}

/**
 * An answer as received by the asker.
 *
 * The provenance line is mandatory and written as prose rather than iconography:
 * it is how the asker knows who stood behind the answer and on what basis. The
 * withheld count is shown; WHICH items were withheld never is — that asymmetry
 * is the disclosure contract made visible.
 */
export function AnswerCard({
  responderName,
  summary,
  items = [],
  disclosedCount,
  withheldCount,
  review,
  countsWithheld = false,
  consentBasis,
  onSave,
  onThank,
}: Props) {
  // Only meaningful when the viewer is actually being given the numbers.
  const withheld = countsWithheld ? null : withheldNote(withheldCount);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <p className="font-medium">{summary}</p>

      {items.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-sm">
              <span className="truncate">{item.label}</span>
              <Badge variant="outline" className="ml-auto shrink-0 text-xs">
                {item.type}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="text-muted-foreground border-t pt-2 text-xs">
        <p>{provenanceLine({ responderName, review, consentBasis })}</p>
        {withheld ? <p className="mt-0.5">{withheld}</p> : null}
        {countsWithheld ? (
          // Said out loud rather than left as a silent zero. See `countsWithheld`.
          <p className="mt-0.5">
            How much this covered, and how much {responderName} held back, are not disclosed to you.
          </p>
        ) : null}
        {!countsWithheld && items.length === 0 && disclosedCount > 0 ? (
          <p className="mt-0.5">Shared as a summary — no individual items were sent.</p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {onSave ? (
          <Button size="sm" onClick={onSave}>
            Save to my memory
          </Button>
        ) : null}
        {onThank ? (
          <Button size="sm" variant="ghost" onClick={onThank}>
            Say thanks
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
