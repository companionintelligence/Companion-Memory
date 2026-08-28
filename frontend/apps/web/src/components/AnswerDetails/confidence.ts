/**
 * How an answer's provenance and confidence are read, shared by the compact
 * badge and the drawer it opens.
 *
 * Lives apart from both so they cannot import each other in a circle: the
 * badge renders the drawer, and the drawer needs the badge's banding.
 */

/**
 * The confidence bands, worded for a reader rather than a statistician, and
 * matched to the scale the model is scored against in
 * `backend/apps/api/src/domains/llm/inferredAnswerConfidence.ts`:
 *
 *   >= 0.9   stated outright in the user's own data
 *   0.7-0.9  strongly implied by repeated, consistent evidence
 *   0.4-0.7  inferred from indirect or partial evidence
 *   < 0.4    a guess — the backend refuses to write these, so this band is
 *            reachable only for rows written before the floor existed
 *
 * The bare band word is what the badge shows; "confidence" is left implicit
 * there and spelled out in the tooltip, the screen-reader text and the drawer.
 */
export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.9) {
    return 'high';
  }

  if (confidence >= 0.7) {
    return 'good';
  }

  if (confidence >= 0.4) {
    return 'low';
  }

  return 'very low';
}

/**
 * What a band is actually claiming, in the same terms the backend's scoring
 * prompt uses. The badge has ~40px and shows the word alone; the drawer has
 * room to say what the word means.
 */
export function confidenceSentence(confidence: number): string {
  if (confidence >= 0.9) {
    return 'Stated outright somewhere in your own data.';
  }

  if (confidence >= 0.7) {
    return 'Strongly implied by repeated, consistent evidence.';
  }

  if (confidence >= 0.4) {
    return 'Inferred from indirect or partial evidence.';
  }

  return 'Little more than a guess — worth correcting if it is wrong.';
}

/** Only `inferred` is a guess; `observed`/`imported`/`user_input` are not. */
export function isInferred(source?: string | null): boolean {
  return source === 'inferred';
}
