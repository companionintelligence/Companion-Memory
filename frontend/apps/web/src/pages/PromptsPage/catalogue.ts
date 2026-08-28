/**
 * The reflection catalogue — the ~1.3k active questions the appliance can ask.
 *
 * Wire types and query building for `GET /api/questions/catalogue`, kept apart
 * from the hook so both can be unit-tested without a renderer.
 */

import type { AnswerEvidenceWire } from '@/components/AnswerDetails';

/** Mirrors `ci.questions.answer_tier` / the `ANSWER_TIERS` const on the API. */
export const ANSWER_TIERS = ['factual', 'preference', 'narrative'] as const;

export type AnswerTier = (typeof ANSWER_TIERS)[number];

export const ANSWER_TIER_LABELS: Record<AnswerTier, string> = {
  factual: 'Fact',
  preference: 'Preference',
  narrative: 'Story',
};

/** What each tier is actually for, in the words a reader needs. */
export const ANSWER_TIER_DESCRIPTIONS: Record<AnswerTier, string> = {
  factual: 'Settles a fact — allergies, birthdays, the name of your street.',
  preference: 'Records a taste — window or aisle, tea or coffee.',
  narrative: 'Asks for a story — how you ended up where you are.',
};

export type CatalogueStatus = 'active' | 'inactive' | 'all';
export type CatalogueAnswered = 'answered' | 'unanswered' | 'all';

export interface CatalogueAnswer {
  id: string;
  text: string;
  /** 'user_input' | 'inferred' | 'observed' | 'imported'. */
  source: string | null;
  confidence: number | null;
  rationale: string | null;
  /**
   * The database rows an inferred answer was read out of, as
   * `QuestionCatalogueAnswer.evidence` sends it. Null for a typed answer, an
   * import, and any inferred row written before the column existed — never an
   * empty citation list, which the speaker gate discards rather than stores.
   *
   * Declared even though the provenance drawer reads it defensively off the
   * whole row: it is what makes this object safe to pass on whole, and it is
   * what breaks the build rather than the drawer if the field is ever renamed.
   */
  evidence: AnswerEvidenceWire | null;
  answeredAt: string;
}

export interface CatalogueEntry {
  id: string;
  /**
   * `ci.questions.question_key` — the stable slug a curated question is known
   * by, seeded by the migration that creates it, null for the ~1.3k rows
   * nobody addresses by name. Anything that hardcodes a fixed set of questions
   * names them by this and not by `id`: ids are minted per appliance, so a
   * hardcoded one matches nothing on anybody else's machine.
   */
  key: string | null;
  text: string;
  category: string | null;
  answerTier: string | null;
  questionType: string | null;
  frequencyRecommendation: string | null;
  isActive: boolean;
  isSeedQuestion: boolean;
  createdByLlm: boolean;
  isPrivateTo: string | null;
  /**
   * Set when this row is the reader's own copy of a shared catalogue reflection.
   * Shared reflections are read-only — every user on the appliance is asked from
   * them — so editing one copies it first. The shared original is hidden from
   * whoever made the copy, and untouched for everybody else.
   */
  forkedFromQuestionId: string | null;
  timesAsked: number;
  timesAnswered: number;
  createdAt: string;
  updatedAt: string;
  answer: CatalogueAnswer | null;
}

export interface CatalogueFacetBucket {
  value: string | null;
  count: number;
}

export interface CataloguePage {
  data: CatalogueEntry[];
  totalCount: number;
  limit: number;
  offset: number;
  facets: {
    categories: CatalogueFacetBucket[];
    answerTiers: CatalogueFacetBucket[];
    answeredCount: number;
    unansweredCount: number;
  };
}

export interface CatalogueFilters {
  search: string;
  /** null = every category. */
  category: string | null;
  answerTier: AnswerTier | null;
  status: CatalogueStatus;
  answered: CatalogueAnswered;
  limit: number;
  offset: number;
}

export const CATALOGUE_PAGE_SIZE = 25;

export const DEFAULT_CATALOGUE_FILTERS: CatalogueFilters = {
  search: '',
  category: null,
  answerTier: null,
  status: 'active',
  answered: 'all',
  limit: CATALOGUE_PAGE_SIZE,
  offset: 0,
};

/**
 * Build the querystring. Empty and null filters are omitted rather than sent
 * blank: the API coerces `limit=`/`offset=` to 0 and would then reject them,
 * and an empty `search=` would be escaped into a pattern that matches nothing
 * useful.
 */
export function buildCatalogueQuery(filters: CatalogueFilters): string {
  const params = new URLSearchParams();

  const search = filters.search.trim();
  if (search) {
    params.set('search', search);
  }

  if (filters.category) {
    params.set('category', filters.category);
  }

  if (filters.answerTier) {
    params.set('answerTier', filters.answerTier);
  }

  params.set('status', filters.status);
  params.set('answered', filters.answered);
  params.set('limit', String(filters.limit));
  params.set('offset', String(filters.offset));

  return params.toString();
}

export function catalogueUrl(filters: CatalogueFilters): string {
  return `/api/questions/catalogue?${buildCatalogueQuery(filters)}`;
}

/** `answer_tier` is nullable in the database; only the three known tiers label. */
export function answerTierLabel(tier: string | null): string | null {
  return tier && tier in ANSWER_TIER_LABELS ? ANSWER_TIER_LABELS[tier as AnswerTier] : null;
}

/** "26–50 of 1,284", or null when there is nothing to place. */
export function rangeLabel(page: Pick<CataloguePage, 'data' | 'offset' | 'totalCount'>): string | null {
  if (page.totalCount === 0 || page.data.length === 0) {
    return null;
  }

  const first = page.offset + 1;
  const last = page.offset + page.data.length;

  return `${first.toLocaleString()}–${last.toLocaleString()} of ${page.totalCount.toLocaleString()}`;
}
