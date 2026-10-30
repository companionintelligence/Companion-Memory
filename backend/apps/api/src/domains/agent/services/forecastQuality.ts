/**
 * Product gates for Forecast: occupancy, forage seed, and next-up share these
 * so junk tokenizer names never become a "named future."
 */

export const MIN_BRANCH_MASS = 0.25;
export const MIN_WEEK_OCCUR = 0.3;

const NEWS_LIKE = new Set(['ransom', 'activist', 'riot', 'hostage', 'protest', 'shooting', 'war', 'attack']);

const JUNK_PHRASES = new Set(['nothink', 'noidea', 'unknown', 'unsorted', 'label']);

export function isUnknownClass(label: string): boolean {
  return label.trim().toUpperCase() === 'UNKNOWN';
}

export function lettersOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, '');
}

/** Drop tokenizer crumbs: Drs, Air_2, Ransom, No Think, UNKNOWN. */
export function isDisplayableLabel(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }

  if (isUnknownClass(trimmed)) {
    return false;
  }

  if (/_\d+$/.test(trimmed)) {
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

export function occupancyLabelOk(label: string, mass: number): boolean {
  return mass >= MIN_BRANCH_MASS && isDisplayableLabel(label);
}

export type QualityCluster = {
  name: string;
  l0_class: string;
  p_occur: number;
  scheduled?: boolean;
};

export function displayNameFor(cluster: QualityCluster): string | null {
  if (isDisplayableLabel(cluster.name)) {
    return cluster.name;
  }

  if (!isUnknownClass(cluster.l0_class) && isDisplayableLabel(cluster.l0_class)) {
    return cluster.l0_class;
  }

  return null;
}

export function clusterPasses(cluster: QualityCluster): boolean {
  if (isDisplayableLabel(cluster.name)) {
    return Boolean(cluster.scheduled) || cluster.p_occur >= MIN_WEEK_OCCUR;
  }

  return Boolean(cluster.scheduled) && displayNameFor(cluster) != null;
}
