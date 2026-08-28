import { ASK_ARCHETYPES, formForArchetype, type AskArchetype } from './askGrammar';
import type { AskQuery, AnswerForm, DisclosedAnswer, DisclosedItem } from './types';

/**
 * Infer the answer FORM from the ask's query. The form drives disclosure
 * minimization: a `boolean`/`existence`/`attribute`/`identity` answer discloses
 * only a yes-no / count / synthesized value, never the underlying items, while a
 * `retrieval` answer may return item references. Pure.
 *
 * ═══ THE ARCHETYPE DECIDES, AND IT DID NOT USED TO ═══
 *
 * `parseAskQueryType` closed `queryType` to {@link ASK_ARCHETYPES}, and
 * {@link formForArchetype} states the form each archetype may produce — but
 * nothing on the disclosure path read it (`formForArchetype` had no production
 * consumer at all), so this function stayed on the OLD open vocabulary and
 * decided by string match with a `retrieval` fallback.
 *
 * Two of the five archetypes matched no branch here and therefore fell through
 * to `retrieval`, the WIDEST form: `content` (declared `existence`) and
 * `availability` (declared `attribute`). An ask that the grammar says may
 * disclose only a count was capped at item references instead. That is a
 * disclosure widening driven by the ASKER's own input, which is the exact class
 * of defect the closed vocabulary exists to prevent — so the archetype is
 * consulted FIRST and wins.
 *
 * The legacy branches below are kept, not replaced. Asks created before the
 * vocabulary closed are still stored with words like `photos`, `where` and
 * `existence`, and they are still answerable; re-inferring them as `retrieval`
 * would widen exactly the rows this change is meant to narrow.
 */
export function inferAnswerForm(query: AskQuery): AnswerForm {
  const queryType = query.queryType.toLowerCase();
  const prompt = query.prompt.toLowerCase();

  // The closed vocabulary first — every ask created through `parseAskQueryType`
  // lands here, and the archetype's declared form is its ceiling.
  if ((ASK_ARCHETYPES as readonly string[]).includes(queryType)) {
    return formForArchetype(queryType as AskArchetype);
  }

  if (['identity', 'identity-claim', 'confirm', 'are-you'].includes(queryType)) {
    return 'identity';
  }

  if (['relationship', 'know', 'boolean'].includes(queryType) || prompt.startsWith('do you know')) {
    return 'boolean';
  }

  if (['attribute', 'where', 'address', 'value'].includes(queryType)) {
    return 'attribute';
  }

  if (queryType === 'existence') {
    return 'existence';
  }

  // photos / files / events / messages / … → the asker may receive references.
  return 'retrieval';
}

/** Only the retrieval form returns item references; all others disclose count/summary only. */
export function formDisclosesItems(form: AnswerForm): boolean {
  return form === 'retrieval';
}

/**
 * Build the disclosure-filtered answer from the raw run-as-owner matches.
 *
 * - The owner's redaction (`redactedIds` — the "deny all but X" set) is applied
 *   here; withheld items are COUNTED but never itemized to the asker.
 * - Only entity `{ id, type }` references cross — never raw node content or
 *   forwardable signed media URLs (the ask path returns references by design,
 *   which is what closes the `entityOwnerScope` signed-URL leak on this path).
 * - Non-retrieval forms carry no item references at all (disclosure minimization).
 *
 * Pure.
 */
export function buildDisclosedAnswer(params: {
  form: AnswerForm;
  matches: readonly DisclosedItem[];
  redactedIds?: readonly string[];
  consentBasis: string | null;
  responderLabel?: string;
}): DisclosedAnswer {
  const redacted = new Set(params.redactedIds ?? []);
  const kept = params.matches.filter((match) => !redacted.has(match.id));
  const withheldCount = params.matches.length - kept.length;
  const disclosedCount = kept.length;

  const items = formDisclosesItems(params.form) ? kept.map((item) => ({ id: item.id, type: item.type })) : [];

  // NOTE: these counts stay truthful here. This record is the owner's own
  // receipt ("you shared 4 of 6") and the source the audit is written from, so
  // blanking it at this layer would blind the owner and the audit to close a
  // leak that only exists on the ASKER's side. The cut is made in
  // `AskAnswerType.toType`, which knows who is looking.
  return {
    form: params.form,
    items,
    disclosedCount,
    withheldCount,
    summary: buildSummary(params.form, disclosedCount, params.responderLabel ?? 'They'),
    consentBasis: params.consentBasis,
  };
}

/**
 * The count-free restatement of a summary, for the projection to the ASKER.
 *
 * The numeric `disclosedCount` is already gated for forms that do not itemize
 * (`AskAnswerType.toType`), but the templated summary embeds the SAME number in
 * prose — "3 matching items." — so gating only the field moved the count oracle
 * from one column of the response into another. This is what the asker may read
 * instead: the yes/no floor the rung already permits, and nothing about
 * magnitude.
 *
 * `hasMatch` is derived from the STORED count, which is post-ceiling — at the
 * `none` rung it is already zero, so a fully withheld answer reads as a
 * negative rather than leaking that anything matched.
 *
 * Pure.
 */
export function countFreeSummary(form: AnswerForm, hasMatch: boolean): string {
  switch (form) {
    case 'boolean':
      return hasMatch ? 'Yes.' : 'No.';
    case 'identity':
      return hasMatch ? 'Confirmed.' : 'Not confirmed.';
    case 'existence':
      return hasMatch ? 'They have at least one matching item.' : 'They have none.';
    case 'attribute':
      return hasMatch ? 'They shared the requested detail.' : 'They had nothing to share.';
    case 'retrieval':
    default:
      // Unreachable in practice: `retrieval` itemizes, so its counts ARE the
      // answer and it never takes this path. Kept total rather than throwing —
      // a new form must degrade to the least-disclosing wording, not crash the
      // projection.
      return hasMatch ? 'They shared some items.' : 'They had nothing to share.';
  }
}

/**
 * A templated, non-leaking summary. Replacing this with an LLM-synthesized
 * natural-language answer (completing the answer-inference RAG path) is a
 * follow-up; the template must never reveal more than the counts/form already do.
 */
function buildSummary(form: AnswerForm, count: number, who: string): string {
  switch (form) {
    case 'boolean':
      return count > 0 ? `${who} confirmed a match.` : `${who} found no match.`;
    case 'existence':
      return count > 0 ? `${who} has ${count} matching item${count === 1 ? '' : 's'}.` : `${who} has none.`;
    case 'attribute':
      return count > 0 ? `${who} shared the requested detail.` : `${who} had nothing to share.`;
    case 'identity':
      return count > 0 ? `${who} confirmed the identity.` : `No match found.`;
    case 'retrieval':
    default:
      return count > 0
        ? `${who} shared ${count} item${count === 1 ? '' : 's'}.`
        : `${who} had nothing to share.`;
  }
}
