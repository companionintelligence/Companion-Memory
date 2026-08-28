import { useMemo, useState } from 'react';

import { Badge, Button, Collapsible, cn } from '@ci/shadcn';
import { ChevronDown, Quote } from '@ci/shadcn/icons';

import {
  VOICE_LABELS,
  citationTypeLabel,
  evidenceScopeSentence,
  formatCitationDate,
  hasEvidenceRecord,
  readAnswerCitations,
  readEvidenceSummary,
  readUncitedRecords,
  unaccountedEvidenceCount,
  type AnswerCitation,
} from './answerEvidence';

/**
 * One database record the appliance read, whether or not the answer rests on it.
 *
 * The voice pill is the load-bearing part: an inbound message is evidence ABOUT
 * a conversation, not a first-person statement by the owner, and reading one
 * back as the owner's own words is the exact bug the attribution work fixed. So
 * it is spelled out per record, never rolled up into a single count, and a
 * record whose voice the API did not report says so instead of defaulting to
 * either side.
 *
 * `muted` is the ONLY thing that separates a cited record from one the model
 * passed over, and it is styling alone on purpose — same component, same fields,
 * same order. Which group it is in is stated in words by the heading above it,
 * because a reader who does not perceive the tint must still be told.
 */
function EvidenceRecord({ citation, muted = false }: { citation: AnswerCitation; muted?: boolean }) {
  const date = formatCitationDate(citation.date);

  return (
    <li
      className={cn(
        'rounded-md border p-2.5',
        muted ? 'border-border/40 bg-transparent' : 'border-border/60 bg-muted/30',
      )}
      data-testid={muted ? 'answer-uncited-record' : 'answer-citation'}
      data-citation-voice={citation.voice ?? 'unknown'}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline" className="text-[10px] font-medium">
          {citationTypeLabel(citation.type)}
        </Badge>

        {citation.voice ? (
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] font-medium',
              citation.voice === 'own'
                ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
                : 'border-sky-500/40 text-sky-700 dark:text-sky-400',
            )}
          >
            {VOICE_LABELS[citation.voice]}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] font-medium text-muted-foreground">
            Speaker not recorded
          </Badge>
        )}

        {date && <span>{date}</span>}
      </div>

      {citation.label && <p className="text-sm font-medium break-words">{citation.label}</p>}

      {citation.snippet && (
        <p
          className={cn(
            'text-sm break-words whitespace-pre-wrap',
            muted ? 'text-muted-foreground' : 'text-foreground/90',
          )}
        >
          {citation.snippet}
        </p>
      )}

      {citation.id && (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground break-all">{citation.id}</p>
      )}
    </li>
  );
}

/**
 * The records the appliance SEARCHED and the model did not cite, behind a
 * disclosure.
 *
 * ═══ WHY THESE ARE SHOWN AT ALL ═══
 *
 * The panel already claimed twenty records were read. Printing that number while
 * showing two is what made the owner believe eighteen were being hidden. There
 * were two ways to fix it: say more precisely what the two are, or show the
 * eighteen. Saying it more precisely still leaves the appliance asserting
 * something about its own retrieval that the owner cannot check — which is the
 * exact posture this whole panel exists to end.
 *
 * ═══ WHY COLLAPSED ═══
 *
 * These are the records the answer does NOT rest on. Open by default they would
 * be nine tenths of the panel, and the two that carry the claim would be the
 * hardest thing in it to find — the failure mode the citation list was
 * deliberately kept short to avoid. Collapsed, the heading still states the
 * count in words, so their existence is never in doubt.
 *
 * Defaults closed and holds its own open state: it is a reading aid, not a
 * setting, and it should not be remembered across two different answers opened
 * from the same page.
 */
function AlsoSearched({ records }: { records: AnswerCitation[] }) {
  const [open, setOpen] = useState(false);
  const own = records.filter((record) => record.voice === 'own').length;
  const other = records.length - own;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="pt-1">
      <Collapsible.Trigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-full justify-start gap-1.5 px-2 text-xs text-muted-foreground"
          data-testid="answer-also-searched-toggle"
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
          {/* Named for what it IS — read and not used — rather than "other
              records", which says nothing about why they are in a second list. */}
          {records.length === 1
            ? 'Also searched: 1 record the model read and did not use'
            : `Also searched: ${records.length} records the model read and did not use`}
        </Button>
      </Collapsible.Trigger>

      <Collapsible.Content className="pt-2">
        {/* The own/other split of the UNUSED set, which is the most useful
            sentence on this panel for anyone auditing the retrieval: an inbound
            line that came back and was correctly left alone is the speaker gate
            visibly working, not a miss. */}
        {other > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            {own === 0
              ? `${other === 1 ? 'This one is' : `All ${other} are`} someone else's words, which can never carry a first-person answer.`
              : `${own} of these are your own records; ${other} ${other === 1 ? 'is' : 'are'} someone else's words, which can never carry a first-person answer.`}
          </p>
        )}

        <ul className="space-y-2">
          {records.map((record) => (
            <EvidenceRecord key={record.key} citation={record} muted />
          ))}
        </ul>
      </Collapsible.Content>
    </Collapsible>
  );
}

/**
 * The body of the drawer's Evidence section: what the answer rests on, what else
 * was read, and — when the two lists cannot account for everything the retrieval
 * reported — an admission of the difference rather than a number the reader is
 * left to reconcile alone.
 *
 * Renders no heading of its own. The `<Section>` wrapper in
 * {@link AnswerDetailsDrawer} owns that, so the panel's heading structure stays
 * in one file while its content lives here.
 */
export function EvidenceSection({ record, inferred }: { record?: unknown; inferred: boolean }) {
  const citations = useMemo(() => readAnswerCitations(record), [record]);
  const summary = useMemo(() => readEvidenceSummary(record), [record]);
  // `null` — not `[]` — when this answer never kept its unused lines. See
  // `readUncitedRecords`: an empty "also searched" group would read as "nothing
  // else was searched", directly contradicting the count beside it.
  const uncited = useMemo(() => readUncitedRecords(record), [record]);
  // "Nothing was recorded" and "something was recorded and it named nothing"
  // are different claims — see `hasEvidenceRecord`.
  const recorded = useMemo(() => hasEvidenceRecord(record), [record]);

  const unaccounted = unaccountedEvidenceCount(citations.length, uncited?.length ?? 0, summary);

  if (citations.length === 0) {
    return (
      // Genuinely empty for a hand-typed answer and for anything written before
      // evidence was recorded, so this says which, rather than reading as a
      // failed load.
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        {!inferred
          ? 'You wrote this yourself, so there is nothing for the appliance to cite.'
          : recorded
            ? `${evidenceScopeSentence(0, summary)} The model was shown records and named none of them.`
            : 'No source records were kept for this answer, so there is nothing to show. Answers inferred from now on record what they were built from.'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* The count that leads is the count of the list underneath it. The
          retrieval total is a second clause and never the headline — see
          `evidenceScopeSentence` for the bug that ordering fixes. */}
      <p className="text-xs text-muted-foreground" data-testid="answer-evidence-scope">
        {evidenceScopeSentence(citations.length, summary)}
      </p>

      <ul className="space-y-2">
        {citations.map((citation) => (
          <EvidenceRecord key={citation.key} citation={citation} />
        ))}
      </ul>

      {uncited && uncited.length > 0 && <AlsoSearched records={uncited} />}

      {/* Both stored arrays are capped, and answers written before the unused
          lines were kept have none at all. Either way the reader can subtract,
          so the shortfall is stated instead of left to be discovered. */}
      {unaccounted > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="answer-evidence-shortfall">
          {unaccounted === 1 ? '1 more record was' : `${unaccounted} more records were`} searched but not kept
          on this answer.
        </p>
      )}
    </div>
  );
}
