/**
 * Display gates for Forecast surfaces. Keep in sync with
 * backend/.../forecastQuality.ts — junk tokenizer names never become a row.
 */

export const MIN_WEEK_OCCUR = 0.3;
export const MIN_PLACE_PROB = 0.3;

const NEWS_LIKE = new Set(['ransom', 'activist', 'riot', 'hostage', 'protest', 'shooting', 'war', 'attack']);

const JUNK_PHRASES = new Set(['nothink', 'noidea', 'unknown', 'unsorted']);

/** Static ambient L1s may occupy the 24h strip but never the week tooltip. */
const AMBIENT_WEEK_LABELS = new Set(['listening', 'watching', 'browsing']);

export function isUnknownClass(label: string): boolean {
  return label.trim().toUpperCase() === 'UNKNOWN';
}

export function lettersOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, '');
}

export function isDisplayableLabel(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || isUnknownClass(trimmed) || /_\d+$/.test(trimmed)) {
    return false;
  }

  const letters = lettersOf(trimmed);
  if (letters.length < 4) {
    return false;
  }

  if (NEWS_LIKE.has(letters) || JUNK_PHRASES.has(letters)) {
    return false;
  }

  return true;
}

export function weekClusterVisible(cluster: {
  name: string;
  l0Class: string;
  pOccur: number;
  scheduled: boolean;
}): boolean {
  if (!isDisplayableLabel(cluster.name)) {
    return false;
  }

  if (AMBIENT_WEEK_LABELS.has(lettersOf(cluster.name))) {
    return false;
  }

  return cluster.scheduled || cluster.pOccur >= MIN_WEEK_OCCUR;
}

export function dueItemVisible(item: { name: string }): boolean {
  return isDisplayableLabel(item.name);
}

export function placeVisible(place: {
  label?: string | null;
  probability?: number;
  share?: number;
}): boolean {
  const label = place.label?.trim() ?? '';
  const probability = place.probability ?? place.share ?? 0;

  return isDisplayableLabel(label) && probability >= MIN_PLACE_PROB;
}
