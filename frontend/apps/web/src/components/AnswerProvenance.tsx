import { useEffect, useRef, useState } from 'react';

import { cn } from '@ci/shadcn';

import { AnswerDetailsDrawer, type AnswerDetails } from './AnswerDetails/AnswerDetailsDrawer';
import { confidenceLabel, isInferred } from './AnswerDetails/confidence';

/**
 * What the badge needs in order to become a button.
 *
 * `source`/`confidence`/`rationale` are NOT repeated here — the badge already
 * takes them and passes its own values down, so the drawer can never disagree
 * with the dot the reader just clicked.
 */
export type AnswerProvenanceDetails = Omit<AnswerDetails, 'source' | 'confidence' | 'rationale'>;

interface Props {
  /** `answerSource` as returned by the API. Undefined on rows that predate it. */
  source?: string | null;
  /** `answerConfidence` in [0,1]. Null/undefined whenever nothing scored the row. */
  confidence?: number | null;
  /** `answerRationale` — the model's one line on the evidence it used. */
  rationale?: string | null;
  /**
   * False when the question has no answer at all. Defaults to true so the many
   * call sites that only ever render alongside an answer stay unchanged.
   */
  answered?: boolean;
  /**
   * The question and answer behind this badge. Supplying it turns the badge
   * into a button that opens {@link AnswerDetailsDrawer}; omitting it leaves
   * the original static badge, so a surface that has not adopted the drawer is
   * unchanged rather than broken.
   */
  details?: AnswerProvenanceDetails;
  className?: string;
}

/**
 * Re-exported from `AnswerDetails/confidence` — they live there so the badge
 * and the drawer it renders do not import each other in a circle. Kept on this
 * module's surface because four call sites and the tests already import them
 * from here.
 */
export { confidenceLabel, isInferred };

/** Who supplied an answer, or that nobody has. */
type ProvenanceState = 'unanswered' | 'inferred' | 'manual';

/**
 * The status light, on a traffic-light mapping the user asked for: red nothing
 * here yet, amber the appliance guessed, green a person confirmed it.
 *
 * The dot is NOT graded by confidence band — it answers "where did this come
 * from?", and the word beside it answers "how sure was it?". `aria-hidden`
 * because the badge's screen-reader text already says both in words.
 */
function ProvenanceDot({ state }: { state: ProvenanceState }) {
  return (
    <span
      className={cn('inline-block size-1.5 shrink-0 rounded-full', {
        'bg-red-500': state === 'unanswered',
        'bg-amber-500': state === 'inferred',
        'bg-emerald-500': state === 'manual',
      })}
      aria-hidden="true"
    />
  );
}

const BASE_CLASS = 'inline-flex items-center gap-1.5 text-xs text-muted-foreground';

/**
 * Interactive chrome for the button form.
 *
 * Deliberately NOT badge/pill chrome — see the component note below for why a
 * bordered pill was wrong at this size. What is added is only what a control
 * owes a keyboard: a hit area a touch bigger than the 6px dot, a hover tint, a
 * visible focus ring in the ring token every other control on the page uses,
 * and a pointer cursor.
 */
const BUTTON_CLASS = cn(
  '-mx-1 -my-0.5 cursor-pointer rounded-sm px-1 py-0.5 transition-colors',
  'hover:bg-muted/60 hover:text-foreground',
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
);

/**
 * Says who wrote an answer, and — when the appliance wrote it — how sure it was.
 * Clicking it opens the full account: the question, the answer, the reasoning
 * sentence, and the database objects the reasoning stood on.
 *
 * Deliberately terse on the face: a dot and, for an inference, one band word
 * ("high", "very low"). A manual answer and an empty row carry the dot alone,
 * because naming them adds nothing a reader scanning a column of answers does
 * not already see. Everything else moved into the drawer (and stays in the
 * `title` tooltip, for a reader who only hovers).
 *
 * No badge chrome: a bordered pill around a 6px dot reads as a control rather
 * than a status, and one per unanswered row turned the column into a grid of
 * empty outlines. It is also ~40 fewer components on this page, which the
 * route-level render budget noticed.
 *
 * Colour is not the only signal, but it IS the only *visible* one at this size:
 * every badge carries visually-hidden text ("Inferred, high confidence") so the
 * distinction survives greyscale, colour-blindness and a screen reader. That is
 * the trade for the compact form — the words moved from the badge face into the
 * accessible name and the tooltip rather than being dropped.
 *
 * ## When it is a button, and when it is not
 *
 * An UNANSWERED row stays a plain `<span>`. There is no answer object behind
 * it — no text, no author, no id to edit — so a drawer could only say "nothing
 * here yet", which the red dot already says. A control that opens a panel with
 * no content in it is the dead button; not rendering a control at all is not.
 *
 * A HAND-TYPED answer, by contrast, does become a button even though it has no
 * rationale and no citations to show. It still has a question, the answer as
 * stored, an author ("you"), a date, and an edit path — and, more to the point,
 * a reader who has learned that this dot opens an explanation will click it on
 * a green row too. Making that one silently inert is worse than a short panel
 * that says, in words, that nothing here was guessed.
 */
export function AnswerProvenance({
  source,
  confidence,
  rationale,
  answered = true,
  details,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // The drawer is unmounted while closed (see below), and unmounting takes
  // Radix's own focus-restore with it — a keyboard user would be dropped at the
  // top of the document after pressing Escape. Put focus back on the badge they
  // opened it from, after the commit that removed the dialog.
  useEffect(() => {
    if (wasOpen.current && !open) {
      buttonRef.current?.focus();
    }

    wasOpen.current = open;
  }, [open]);

  if (!answered) {
    return (
      <span className={cn(BASE_CLASS, className)} title="No answer yet">
        <ProvenanceDot state="unanswered" />
        <span className="sr-only">No answer yet</span>
      </span>
    );
  }

  const inferred = isInferred(source);
  const scored = typeof confidence === 'number' && Number.isFinite(confidence);
  const band = inferred && scored ? confidenceLabel(confidence) : null;

  const stateText = !inferred
    ? 'Answered by you'
    : band
      ? `Inferred, ${band} confidence`
      : 'Inferred, confidence not recorded';

  const title = !inferred
    ? 'You wrote this answer'
    : [
        scored
          ? `Inferred from your data — confidence ${confidence.toFixed(2)}`
          : 'Inferred from your data — confidence not recorded',
        rationale || null,
        'Edit it to make it yours.',
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n');

  const face = (
    <>
      <ProvenanceDot state={inferred ? 'inferred' : 'manual'} />
      <span className="sr-only">{stateText}</span>
      {band && <span aria-hidden="true">{band}</span>}
    </>
  );

  if (!details) {
    return (
      <span className={cn(BASE_CLASS, className)} title={title}>
        {face}
      </span>
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        // The sr-only span above is kept (so the same text is findable however
        // the badge renders), but the button's own name has to also say what
        // pressing it does — `aria-label` wins over the child text.
        aria-label={`${stateText}. Show where this answer came from.`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${title}\nClick for details.`}
        onClick={(event) => {
          // Grid cards and list rows put their own click handler on an ancestor
          // (EntityGridItem navigates). Asking for provenance is not asking to
          // open the entity.
          event.stopPropagation();
          setOpen(true);
        }}
        className={cn(BASE_CLASS, BUTTON_CLASS, className)}
      >
        {face}
      </button>

      {/* Mounted only while open, on purpose. The Self page renders one of
          these per curated question and the Reflections table one per row, so a
          permanently-mounted Radix dialog per badge would be dozens of idle
          portals, focus scopes and layout subscriptions for a panel almost none
          of them will ever show. The cost is the close animation, which a
          details panel does not need. */}
      {open && (
        <AnswerDetailsDrawer
          open
          onOpenChange={setOpen}
          details={{ ...details, source, confidence, rationale }}
        />
      )}
    </>
  );
}
