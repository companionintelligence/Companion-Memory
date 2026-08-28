import { useMemo } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Button, Separator, Sheet, cn } from '@ci/shadcn';
import { Pencil, Sparkles, UserRound } from '@ci/shadcn/icons';

import { formatCitationDate, readEvidenceSummary } from './answerEvidence';
import { EvidenceSection } from './EvidenceSection';
import { confidenceLabel, confidenceSentence, isInferred } from './confidence';

/**
 * Everything the drawer needs about one question and its answer. Narrow on
 * purpose: four surfaces render `AnswerProvenance` off four different wire
 * shapes (REST catalogue rows, REST `/api/answers`, a GraphQL fragment), and
 * this is the one vocabulary they all map into.
 */
export interface AnswerDetails {
  /** The question, as asked. */
  question: string;
  /** The answer, exactly as stored — never truncated here. */
  answerText: string;
  /** `ci.answers.answer_source`. */
  source?: string | null;
  /** `ci.answers.answer_confidence`, [0,1]. */
  confidence?: number | null;
  /** `ci.answers.answer_rationale` — the model's one sentence on its reasoning. */
  rationale?: string | null;
  /** `ci.answers.answered_at`, when the surface has it. */
  answeredAt?: string | null;
  /**
   * The raw answer row as the API returned it. Citations are read off this
   * defensively (see `answerEvidence.ts`) so no call site has to know — or
   * track — which field the backend hangs evidence on.
   */
  record?: unknown;
  /**
   * Hand back to the caller's EXISTING answer-edit path. Absent on surfaces
   * that have no way to rewrite an answer, and the edit affordance is then
   * hidden rather than shown dead.
   */
  onEdit?: () => void;
}

interface Props {
  details: AnswerDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The badge lumps everything that is not `inferred` into one green dot, because
 * at 6px the only question it can answer is "did the appliance guess this?".
 * Here there is room to be accurate: an imported answer was not typed by the
 * owner, and an observed one was not typed at all — telling a reader they wrote
 * something they did not would be a small lie in the one panel that exists to
 * stop the appliance making claims it cannot back.
 */
function notInferredSentence(source?: string | null): string {
  if (source === 'imported') {
    return 'This answer arrived with an import of your own data — the appliance did not guess it.';
  }

  if (source === 'observed') {
    return 'This was recorded from something you actually did, rather than inferred from it.';
  }

  return 'You wrote this answer yourself. Nothing was guessed.';
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-1.5', className)}>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The whole story behind one Q&A: what was asked, what is stored, who put it
 * there, how sure they were, the one sentence of reasoning, and every database
 * object that reasoning stood on.
 *
 * Opened from the provenance badge on the Self page and the Reflections
 * surfaces. Built on `Sheet` (the shared Radix-dialog primitive), so focus
 * trapping, Escape, the overlay and `role="dialog"` — which is what the badge's
 * `aria-haspopup="dialog"` promises — all come from the same place as every
 * other modal in the app.
 *
 * ## Why a side panel and not a centred dialog
 *
 * This is a reading panel, not a decision. A citation list is unbounded (the
 * writer caps at 8, the jsonb column does not), so the reader scrolls, and
 * scrolling a centred box that grows and shrinks around its own content is
 * worse than scrolling a column pinned to the edge. A right-hand panel also
 * leaves the answer it explains on screen behind it.
 */
export function AnswerDetailsDrawer({ details, open, onOpenChange }: Props) {
  const { question, answerText, source, confidence, rationale, answeredAt, onEdit } = details;
  const { isMobile } = useDeviceLayout();

  // Only the model name is read here; everything else about the retrieval is
  // read — and reconciled — inside `EvidenceSection`.
  const summary = useMemo(() => readEvidenceSummary(details.record), [details.record]);

  const inferred = isInferred(source);
  const scored = typeof confidence === 'number' && Number.isFinite(confidence);
  const answered = formatCitationDate(answeredAt ?? null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/*
        Right on a desktop, up from the bottom on a phone — a right-hand panel
        on a 375px screen is the whole screen with a seam down one side, and
        every other modal in this app already arrives from the bottom there.

        The desktop width is the one number worth arguing about. The default
        sheet is `sm:max-w-sm` — 24rem, ~384px — which after the panel's own
        24px gutters and each citation card's 10px padding leaves ~316px of
        text: a UUID at `text-[10px]` mono fits, but a `text-sm` snippet breaks
        every ~45 characters and the confidence sentence wraps to three lines.
        36rem leaves ~500px inside a citation card — around 70 characters, the
        comfortable measure — and keeps
        "good confidence (0.82). Strongly implied by…" on one line. It stays a
        rem so it tracks the app's root size (17px here, so ~612px rendered)
        rather than pinning the measure to one type scale, and even at the
        narrowest desktop viewport (896px, where `useDeviceLayout` hands over
        to the phone layout) it leaves the answer it explains visible beside
        it.
      */}
      <Sheet.Content
        side={isMobile ? 'bottom' : 'right'}
        className={cn(
          // Header and footer are siblings of the scroll region, not inside
          // it, so the gutters live on each band rather than on the frame.
          'gap-0',
          isMobile
            ? 'max-h-[min(90dvh,var(--vv-height,100dvh))] rounded-t-2xl rounded-b-none'
            : 'w-full sm:max-w-[36rem]',
        )}
      >
        {isMobile && (
          <div className="mx-auto mt-3 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />
        )}

        {/* `pr-12` clears the primitive's own close button, which is absolutely
            positioned at top-right and would otherwise sit on the title. */}
        <Sheet.Header className="shrink-0 gap-2 border-b border-border/60 px-6 pt-4 pr-12 pb-3 text-left">
          <Sheet.Title className="flex items-center gap-2 text-base">
            {inferred ? (
              <Sparkles className="h-4 w-4 shrink-0 text-amber-500" strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <UserRound className="h-4 w-4 shrink-0 text-emerald-500" strokeWidth={1.5} aria-hidden="true" />
            )}
            {inferred ? 'Where this answer came from' : 'Your answer'}
          </Sheet.Title>

          {/* The question is the dialog's description rather than a body
              heading: it is literally what this dialog is about, so a screen
              reader should hear it on open without hunting for it. Never
              blank — an empty description is a dialog that announces nothing,
              and `/api/answers` can return an answer whose question did not
              come back with it. */}
          <Sheet.Description className="text-sm text-foreground/80 break-words">
            {question.trim() || 'This reflection’s wording was not returned with the answer.'}
          </Sheet.Description>
        </Sheet.Header>

        {/* The only scroller. `min-h-0` is what lets it shrink inside the
            column instead of pushing the footer off the bottom, which is also
            what keeps the header and the "Correct this answer" action fixed
            while a twenty-citation list scrolls between them. */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
          <Section title="Answer">
            <p className="rounded-md bg-muted/40 p-2.5 text-sm break-words whitespace-pre-wrap">
              {answerText}
            </p>
          </Section>

          <Separator />

          <Section title="Who answered">
            {inferred ? (
              <div className="space-y-1 text-sm">
                <p>Your appliance inferred this from your own data — you have not confirmed it.</p>
                <p className="text-muted-foreground">
                  {scored
                    ? `${confidenceLabel(confidence)} confidence (${confidence.toFixed(2)}). ${confidenceSentence(confidence)}`
                    : 'Confidence was never recorded for this answer.'}
                </p>
                {summary.model && (
                  <p className="text-muted-foreground">
                    Written by <span className="font-mono text-xs">{summary.model}</span>
                    {answered ? ` on ${answered}` : ''}.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm">
                {notInferredSentence(source)}
                {answered ? ` Recorded on ${answered}.` : ''}
              </p>
            )}
          </Section>

          {inferred && (
            <Section title="Reasoning">
              {rationale ? (
                <p className="text-sm break-words">{rationale}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No reasoning sentence was recorded for this answer.
                </p>
              )}
            </Section>
          )}

          {/* Deliberately NOT `Evidence (2)`. A count in the heading of a panel
              that also prints a retrieval total is the ambiguity this section
              was misread through — see `evidenceScopeSentence`. The counts now
              live in one sentence that says which is which. */}
          <Section title="Evidence">
            <EvidenceSection record={details.record} inferred={inferred} />
          </Section>
        </div>

        {/* Bottom band, never scrolled away: the whole point of reading this
            panel is deciding whether to correct the answer. The bottom padding
            clears the home indicator on a phone. */}
        <Sheet.Footer className="mt-0 shrink-0 flex-row items-center justify-between gap-2 border-t border-border/60 px-6 py-3 pb-[max(0.75rem,var(--safe-area-bottom))]">
          {onEdit ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                // Close first: every surface that supplies `onEdit` reveals its
                // own inline editor underneath, and that editor autofocuses.
                onOpenChange(false);
                onEdit();
              }}
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              {inferred ? 'Correct this answer' : 'Edit this answer'}
            </Button>
          ) : (
            <span />
          )}

          <Sheet.Close asChild>
            <Button type="button" size="sm" variant="ghost">
              Close
            </Button>
          </Sheet.Close>
        </Sheet.Footer>
      </Sheet.Content>
    </Sheet>
  );
}
