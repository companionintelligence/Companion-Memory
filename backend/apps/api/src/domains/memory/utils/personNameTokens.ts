/**
 * Display-name tokenization for people resolution.
 *
 * Exact normalized names (`normalizeName`) are an identifier: two claims that
 * share the whole string are one fact. Variant matching is a different job —
 * "mr broza" and "william d broza" never share that string, but they share a
 * distinctive name *element*. This module is the single rule for breaking a
 * display name into those elements and deciding whether two names are a
 * question ("should these be the same person?") rather than an answer.
 *
 * Honorifics and generational suffixes are stripped before comparison so
 * "Mr. William Broza" and "william broza" collapse to the same token set.
 * A last-name conflict ("john smith" vs "john jones") is never a match.
 * One token set being a subset of the other ("william" ⊂ "william broza",
 * "broza" ⊂ "william d broza") is a match — uniqueness of that match is
 * the detector's problem, not this one.
 *
 * Folding is the same NFKD rule as `normalizeName` in the graph domain,
 * inlined so this file does not import graph internals (or the graph
 * barrel, which would cycle through MemoryModule).
 */

function foldDisplayName(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > 0 ? normalized : null;
}

/** Leading titles. Matched only at the start of the remaining token list. */
const HONORIFICS = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'mz',
  'mx',
  'dr',
  'prof',
  'professor',
  'sir',
  'madam',
  'lady',
  'lord',
  'rev',
  'reverend',
  'hon',
  'honorable',
  'dame',
  'fr',
  'father',
  'rabbi',
]);

/** Trailing generational / professional suffixes. Matched only at the end. */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq', 'jd']);

export type NameTokenRole = 'given' | 'middle' | 'family' | 'initial';

export interface PersonNameToken {
  value: string;
  role: NameTokenRole;
}

export interface TokenizedPersonName {
  /** Role-tagged tokens, honorifics and suffixes already dropped. */
  tokens: PersonNameToken[];
  /** Unique token values in first-seen order. */
  values: string[];
  set: Set<string>;
  given: string | null;
  family: string | null;
  /** True when an honorific was stripped — a remaining lone token is a surname. */
  hadHonorific: boolean;
  /** "Priya's brother" — a relation, not a name. Never a merge signal. */
  isRelational: boolean;
  display: string;
}

export const NAME_OVERLAP_SCORES = {
  /** Shared family token, shorter name is a subset ("mr broza" ⊂ "william d broza"). */
  family: 0.62,
  /** Same tokens after honorific/suffix strip ("Mr William Broza" vs "william broza"). */
  variant: 0.58,
  /** Proper subset that is more than a bare given name ("william broza" ⊂ "william d broza"). */
  subset: 0.55,
  /** Bare given name is a subset ("william" ⊂ "william broza"). At the name floor. */
  given: 0.5,
} as const;

export type NameOverlapKind = 'variant' | 'family' | 'subset' | 'given';

export interface NameOverlap {
  kind: NameOverlapKind;
  score: number;
  shared: string[];
}

/** Possessive relation ("Priya's brother"), not a personal name. */
export function isRelationalDescriptor(name: string | null | undefined): boolean {
  return /['’]s(?=\s|$)/i.test(name ?? '');
}

function isInitial(value: string): boolean {
  return value.length === 1;
}

/**
 * Split a display name into comparable tokens.
 *
 * Empty / whitespace input is null. A name that is only honorifics is null.
 */
export function tokenizePersonName(raw: string | null | undefined): TokenizedPersonName | null {
  const normalized = foldDisplayName(raw);
  if (normalized == null) {
    return null;
  }

  const relational = isRelationalDescriptor(raw ?? normalized);
  const stripped = normalized
    .replace(/['’]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped.length === 0) {
    return null;
  }

  const rawTokens = stripped.split(' ').filter(Boolean);
  let start = 0;
  let end = rawTokens.length;
  let hadHonorific = false;

  while (start < end && HONORIFICS.has(rawTokens[start])) {
    hadHonorific = true;
    start += 1;
  }

  while (end > start && SUFFIXES.has(rawTokens[end - 1])) {
    end -= 1;
  }

  const content = rawTokens.slice(start, end);
  if (content.length === 0) {
    return null;
  }

  const tokens: PersonNameToken[] = content.map((value, index) => {
    if (isInitial(value)) {
      return { value, role: 'initial' as const };
    }

    if (content.length === 1) {
      return { value, role: hadHonorific ? 'family' : 'given' };
    }

    if (index === 0) {
      return { value, role: 'given' as const };
    }

    if (index === content.length - 1) {
      return { value, role: 'family' as const };
    }

    return { value, role: 'middle' as const };
  });

  const values: string[] = [];
  const set = new Set<string>();
  for (const token of tokens) {
    if (!set.has(token.value)) {
      values.push(token.value);
      set.add(token.value);
    }
  }

  const given = tokens.find((token) => token.role === 'given')?.value ?? null;
  const family = tokens.find((token) => token.role === 'family')?.value ?? null;

  return {
    tokens,
    values,
    set,
    given,
    family,
    hadHonorific,
    isRelational: relational,
    display: content.join(' '),
  };
}

/** Tokens long enough to look up other people by — initials are too common. */
export function indexableTokens(name: TokenizedPersonName): string[] {
  return name.values.filter((value) => value.length >= 2);
}

function isSubset(inner: Set<string>, outer: Set<string>): boolean {
  if (inner.size === 0 || inner.size > outer.size) {
    return false;
  }

  for (const value of inner) {
    if (!outer.has(value)) {
      return false;
    }
  }

  return true;
}

/**
 * Compare two tokenized names. Null means "not a question" — different last
 * names, a relational descriptor, or no subset relation.
 *
 * Ambiguity (Discord "william" vs several email Williams) is not decided here:
 * the same pair-level answer is returned either way. The detector counts how
 * many people the shorter name fits and either files a pair, a cluster, or
 * nothing.
 */
export function compareTokenizedNames(
  left: TokenizedPersonName,
  right: TokenizedPersonName,
): NameOverlap | null {
  if (left.set.size === 0 || right.set.size === 0) {
    return null;
  }

  if (left.isRelational || right.isRelational) {
    return null;
  }

  // "john smith" vs "john jones" — last tokens disagree and neither appears
  // in the other name. "william david" vs "william david broza" is NOT this:
  // the shorter name's last token is a middle name in the longer form.
  if (
    left.family != null &&
    right.family != null &&
    left.family !== right.family &&
    !left.set.has(right.family) &&
    !right.set.has(left.family)
  ) {
    return null;
  }

  const leftInRight = isSubset(left.set, right.set);
  const rightInLeft = isSubset(right.set, left.set);

  if (!leftInRight && !rightInLeft) {
    return null;
  }

  const shared = left.values.filter((value) => right.set.has(value));

  if (leftInRight && rightInLeft) {
    return { kind: 'variant', score: NAME_OVERLAP_SCORES.variant, shared };
  }

  const shorter = left.set.size <= right.set.size ? left : right;
  const longer = shorter === left ? right : left;

  if (shorter.family != null && (longer.family == null || longer.family === shorter.family)) {
    return { kind: 'family', score: NAME_OVERLAP_SCORES.family, shared };
  }

  // A bare token with no honorific is tagged `given`, but if it equals the
  // other side's family name ("broza" vs "william d broza") it is a surname
  // match, not a first-name match.
  if (shorter.family == null && longer.family != null && shorter.set.has(longer.family)) {
    return { kind: 'family', score: NAME_OVERLAP_SCORES.family, shared };
  }

  if (shorter.values.length === 1 && shorter.given != null) {
    return { kind: 'given', score: NAME_OVERLAP_SCORES.given, shared };
  }

  return { kind: 'subset', score: NAME_OVERLAP_SCORES.subset, shared };
}

/**
 * The display name that should survive a merge: the token-superset, then the
 * longest string. Never shrinks "william d broza" down to "mr broza" just
 * because the stub was the merge target.
 */
export function pickFullerName(names: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestTokens: TokenizedPersonName | null = null;

  for (const name of names) {
    if (name == null || name.trim() === '') {
      continue;
    }

    const tokens = tokenizePersonName(name);

    if (best == null) {
      best = name;
      bestTokens = tokens;
      continue;
    }

    if (tokens == null) {
      continue;
    }

    if (bestTokens == null || tokens.set.size > bestTokens.set.size) {
      best = name;
      bestTokens = tokens;
      continue;
    }

    if (tokens.set.size === bestTokens.set.size && name.trim().length > best.trim().length) {
      best = name;
      bestTokens = tokens;
    }
  }

  return best;
}
