import { useEffect, useState } from 'react';

import { cn } from '@ci/shadcn';

/**
 * The one avatar rendering used everywhere a Person (or the signed-in user)
 * appears — the People grid, the person editor's preview, the nav/power rail
 * identity corner, and every counterparty row on the Asks page.
 *
 * ═══ WHY INITIALS ARE THE COMMON CASE, NOT THE EDGE CASE ═══
 *
 * On a real appliance today essentially no Person entities have `avatarUrl`
 * set (measured: 0 of 65 on a live box), so the no-photo rendering below is
 * what almost everybody sees almost all the time. It has to look like a
 * finished product, not a broken-image placeholder — hence a real, named,
 * contrast-checked palette rather than a generic person glyph.
 *
 * ═══ THE PALETTE IS FIXED, NOT COMPUTED ═══
 *
 * A tempting alternative is deriving a background colour from the name at
 * runtime (e.g. `hsl(hash(name) % 360, 70%, 40%)`). That was rejected: an HSL
 * value picked without checking it is un-auditable — nothing stops the hash
 * landing on a hue/lightness pair that fails contrast against the text
 * colour it is paired with, and by the time that happens for a real person's
 * name in production nobody is checking. Every entry below is a literal,
 * checked hex pair instead, so the guarantee holds for every input, forever.
 *
 * The eight background colours are LITERAL hex, not `var(--...)` tokens, and
 * that is deliberate too: they must hold their contrast ratio against white
 * text in both the light and dark theme (this app toggles a `.dark` class
 * rather than following `prefers-color-scheme`, see
 * `@companionintelligence/tokens/globals.css`), and a token that is
 * redefined per-theme cannot make that promise. A literal, opaque, filled
 * circle needs no theme awareness at all — it looks the same colour sitting
 * on either background, which is what "works in both themes" means for a
 * solid shape rather than a themed one. Anything else in this component that
 * DOES need to track the theme (the fallback ring, the icon glyph on an
 * empty label) uses the app's CSS variables instead, the same way the rest
 * of the app does.
 *
 * ═══ CONTRAST NUMBERS (WCAG 2.1, relative-luminance formula, computed not
 * eyeballed — see the ratio beside every entry) ═══
 *
 * Every entry pairs its background with #ffffff text and clears the 4.5:1
 * minimum required for normal text (WCAG 2.1 SC 1.4.3, Level AA):
 *
 *   name    background   ratio
 *   teal    #0a6358      7.15:1
 *   blue    #075985      7.56:1
 *   green   #166534      7.13:1
 *   amber   #a16207      4.92:1
 *   orange  #9a3412      7.31:1
 *   red     #b91c1c      6.47:1
 *   rose    #9d174d      7.88:1
 *   violet  #5b21b6      8.98:1
 *
 * (`teal` is the brand phthalo used elsewhere in this design system; the
 * other seven were chosen to sit at visibly different hues around the wheel
 * so a list of many people reads as distinguishable colours, not as shades
 * of the same one.)
 */
const PALETTE: readonly { readonly bg: string; readonly fg: string }[] = [
  { bg: '#0a6358', fg: '#ffffff' }, // teal   7.15:1
  { bg: '#075985', fg: '#ffffff' }, // blue   7.56:1
  { bg: '#166534', fg: '#ffffff' }, // green  7.13:1
  { bg: '#a16207', fg: '#ffffff' }, // amber  4.92:1
  { bg: '#9a3412', fg: '#ffffff' }, // orange 7.31:1
  { bg: '#b91c1c', fg: '#ffffff' }, // red    6.47:1
  { bg: '#9d174d', fg: '#ffffff' }, // rose   7.88:1
  { bg: '#5b21b6', fg: '#ffffff' }, // violet 8.98:1
];

/**
 * Concrete pixel sizes. `sm` is deliberately 32px — the exact size
 * `PersonGridItem`'s `h-8 w-8` already rendered before this component
 * existed, so consolidating that call site is a no-op for anyone who already
 * has a photo. `md` matches the 40px `Avatar` PeoplePage used for its list
 * rows; `lg` matches the 48px used on the mobile profile hub; `xs` is for the
 * Asks page's tightened, one-line rows, where a full 32px circle would fight
 * the badge and button beside it for space.
 */
const SIZES = {
  xs: { box: 'size-6', text: 'text-[10px]' },
  sm: { box: 'size-8', text: 'text-xs' },
  md: { box: 'size-10', text: 'text-sm' },
  lg: { box: 'size-12', text: 'text-base' },
} as const;

export type PersonAvatarSize = keyof typeof SIZES;

/**
 * A stable small-integer hash of a string.
 *
 * djb2 — chosen only because it is short, well-known, and has no external
 * dependency. Nothing about the choice of algorithm matters beyond it being
 * deterministic: the same `seed` must always land on the same palette
 * index, for as long as this app runs, so that the same person always shows
 * the same colour.
 */
function hashSeed(seed: string): number {
  let hash = 5381;

  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 33) ^ seed.charCodeAt(i);
  }

  return hash >>> 0;
}

/**
 * Up to two initials from a label.
 *
 * Takes the first alphanumeric character of each of the first two
 * whitespace-separated words — not simply the first character of each word —
 * so a label that starts with punctuation (the "…abc123" id fragments this
 * app already shows for an unnamed counterparty) still yields a legible
 * letter pair instead of an ellipsis. A label with nothing alphanumeric in it
 * at all (blank, or symbols only) falls back to "?", the same convention
 * PeoplePage used before this component existed.
 */
export function initialsFor(label: string | null | undefined): string {
  const trimmed = label?.trim();

  if (!trimmed) {
    return '?';
  }

  const words = trimmed.split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = words
    .map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0]?.toUpperCase() ?? '')
    .filter(Boolean)
    .join('');

  return letters || '?';
}

/** The deterministic {bg, fg} pair for a label — exported so tests can assert on it directly. */
export function paletteFor(label: string | null | undefined): { readonly bg: string; readonly fg: string } {
  const seed = label?.trim() || '?';

  return PALETTE[hashSeed(seed) % PALETTE.length]!;
}

/**
 * The same absolute-or-`/static`-relative convention every avatar-rendering
 * call site already used ad hoc: a full URL is used as-is, anything else is
 * assumed to be an object-store-relative path and gets `/static` prefixed.
 *
 * A `data:` URI is a THIRD case, not a variant of either: it is already the
 * complete image, not a reference to fetch one, so it must be returned as-is
 * too. Before this branch existed, one slipped through the relative-path
 * fallback and got `/static` prepended onto it — `vcard.ts` embeds a
 * contact's photo as exactly this (`data:image/jpeg;base64,...`), so every
 * vCard-imported Person with a real photo requested
 * `/staticdata:image/jpeg;base64,...`, a path that cannot resolve to
 * anything, got a 400, and fell back to initials. Confirmed against a real
 * 4,697-person import: every contact carrying a data: URI avatar showed
 * initials instead of their photo.
 */
function resolveAvatarUrl(avatarUrl: string | null | undefined): string | undefined {
  const trimmed = avatarUrl?.trim();

  if (!trimmed) {
    return undefined;
  }

  if (/^https?:\/\//.test(trimmed) || trimmed.startsWith('data:')) {
    return trimmed;
  }

  return `/static${trimmed}`;
}

interface Props {
  /** Used for initials, the deterministic colour seed, and (with no photo) the alt text. */
  name: string | null | undefined;
  /** Same absolute-or-`/static`-relative convention as every other avatar in this app. */
  avatarUrl?: string | null;
  size?: PersonAvatarSize;
  className?: string;
}

/**
 * A photo when there is one; otherwise initials on a deterministic,
 * contrast-checked colour. Never a broken-image glyph — a 404 (or any other
 * load failure) falls back to the initials state rather than leaving the
 * browser's own broken-image icon on screen.
 */
export function PersonAvatar({ name, avatarUrl, size = 'sm', className }: Props) {
  const resolved = resolveAvatarUrl(avatarUrl);
  const [failed, setFailed] = useState(false);

  // A new URL (a different person, or a retry after an edit) deserves its own
  // chance to load — without this, a component that failed once for id A
  // would still show initials after being reused for id B's photo.
  useEffect(() => {
    setFailed(false);
  }, [resolved]);

  const { box, text } = SIZES[size];
  const showPhoto = resolved != null && !failed;

  if (showPhoto) {
    return (
      <img
        src={resolved}
        alt={name?.trim() || ''}
        onError={() => setFailed(true)}
        className={cn(box, 'shrink-0 rounded-full object-cover', className)}
      />
    );
  }

  const { bg, fg } = paletteFor(name);

  return (
    <span
      role="img"
      aria-label={name?.trim() || 'No name'}
      className={cn(
        box,
        text,
        'flex shrink-0 items-center justify-center rounded-full font-semibold',
        className,
      )}
      style={{ backgroundColor: bg, color: fg }}
    >
      {initialsFor(name)}
    </span>
  );
}
