import { Button, cn } from '@ci/shadcn';
import { Loader2, Sparkles } from '@ci/shadcn/icons';

import type { HowYoudDoItResult } from '@/api/usePersonaCompose';

interface HowYoudDoItCardProps {
  result: HowYoudDoItResult;
  applying?: boolean;
  applyNote?: string | null;
  onApply?: () => void;
  /**
   * Answering a follow-up is what sharpens the next compose. When omitted the
   * questions still render, as plain text rather than dead buttons.
   */
  onFollowUp?: (question: string) => void;
  className?: string;
}

/**
 * Structured preview for a personalized approach — suggest-only, never schedules.
 */
export function HowYoudDoItCard({
  result,
  applying,
  applyNote,
  onApply,
  onFollowUp,
  className,
}: HowYoudDoItCardProps) {
  return (
    <div
      className={cn(
        'w-full max-w-xl rounded-xl border border-border bg-background p-4 text-left shadow-sm',
        className,
      )}
    >
      <div className="mb-3 flex items-start gap-2">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
          <Sparkles className="h-4 w-4 text-foreground/70" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">How you’d do it</p>
          <h3 className="text-[15px] font-semibold leading-snug text-foreground">{result.task.title}</h3>
          {result.task.goal && <p className="mt-0.5 text-xs text-muted-foreground">{result.task.goal}</p>}
        </div>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {Math.round(result.confidence * 100)}%
        </span>
      </div>

      <p className="mb-3 text-[13px] leading-relaxed text-foreground/90">{result.personaBrief}</p>

      {result.approach.length > 0 ? (
        <ol className="mb-3 space-y-2">
          {result.approach.map((step, index) => (
            <li key={`${step.title}-${index}`} className="flex gap-2 text-[13px]">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="font-medium text-foreground">{step.title}</p>
                {step.detail && <p className="text-xs text-muted-foreground">{step.detail}</p>}
                {step.durationMinutes != null && (
                  <p className="text-[10px] tabular-nums text-muted-foreground">{step.durationMinutes}m</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mb-3 text-[13px] text-muted-foreground">
          Not enough signal to personalize confidently yet — answer the follow-ups below or correct what
          Companion knows about you.
        </p>
      )}

      {(result.timing || result.people.length > 0) && (
        <div className="mb-3 space-y-1 text-xs text-muted-foreground">
          {result.timing && <p>Timing: {result.timing}</p>}
          {result.people.length > 0 && <p>People: {result.people.join(', ')}</p>}
        </div>
      )}

      {result.evidence.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {result.evidence.slice(0, 6).map((item, index) => (
            <span
              key={`${item.kind}-${item.id ?? index}`}
              className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
            >
              {item.note}
            </span>
          ))}
        </div>
      )}

      {result.followUps.length > 0 && (
        <div className="mb-3 space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">Follow-ups</p>
          {result.followUps.map((question) =>
            onFollowUp ? (
              <button
                key={question}
                type="button"
                onClick={() => onFollowUp(question)}
                className="block w-full rounded-md border border-border px-2.5 py-1.5 text-left text-[12px] text-foreground hover:border-primary/50"
              >
                {question}
              </button>
            ) : (
              <p key={question} className="text-[12px] text-muted-foreground">
                {question}
              </p>
            ),
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {onApply && result.approach.length > 0 && (
          <Button size="sm" className="h-7 text-xs" disabled={applying} onClick={onApply}>
            {applying ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
            ) : (
              <Sparkles className="mr-1 h-3.5 w-3.5" strokeWidth={1.5} />
            )}
            Add to Possibilities
          </Button>
        )}

        {applyNote && <span className="text-[11px] text-muted-foreground">{applyNote}</span>}
      </div>
    </div>
  );
}
