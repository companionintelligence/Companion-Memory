/**
 * Frontend mirror of backend `personNameTokens.ts`.
 *
 * Used to highlight shared name parts and to cluster a bare given name
 * ("william") against several fuller people. Must stay a subset of the
 * server rule: honorifics/suffixes stripped, last-name conflict is a
 * server decision we do not re-derive here.
 */

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

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq', 'jd']);

export interface TokenizedDisplayName {
  values: string[];
  set: Set<string>;
  given: string | null;
  family: string | null;
}

export function tokenizeDisplayName(raw: string | null | undefined): TokenizedDisplayName | null {
  if (raw == null) {
    return null;
  }

  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length === 0) {
    return null;
  }

  const rawTokens = normalized.split(' ').filter(Boolean);
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

  const values = [...new Set(content)];
  const given = !hadHonorific || content.length > 1 ? content[0] : null;
  const family =
    content.length === 1 && hadHonorific
      ? content[0]
      : content.length > 1
        ? content[content.length - 1]
        : null;

  return { values, set: new Set(values), given, family };
}

export function isGivenNameOnly(name: string | null | undefined): boolean {
  const tokens = tokenizeDisplayName(name);

  return tokens != null && tokens.values.length === 1 && tokens.given != null;
}

export function sharedNameTokens(left: string | null | undefined, right: string | null | undefined): Set<string> {
  const a = tokenizeDisplayName(left);
  const b = tokenizeDisplayName(right);
  if (a == null || b == null) {
    return new Set();
  }

  return new Set(a.values.filter((value) => b.set.has(value)));
}
