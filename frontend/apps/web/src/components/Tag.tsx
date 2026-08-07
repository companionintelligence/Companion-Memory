import { useMemo } from 'react';

import { Badge, cn } from '@ci/shadcn';

interface Props {
  icon?: React.ReactNode;
  text: string;
  children?: React.ReactNode;
  className?: string;
}

export function Tag({ icon, text, children, className }: Props) {
  const swatch = useMemo(() => getSwatchFromPalette(text), [text]);

  return (
    <Badge className={cn(className, swatch.bg, swatch.fg, 'flex items-center border-0')}>
      {icon}
      <span>{text}</span>
      {children}
    </Badge>
  );
}

const FNV_PRIME = 16777619;
const FNV_OFFSET_BASIS = 2166136261;

/**
 * Tag colours, each paired with the foreground that actually reads on it.
 *
 * The foreground used to be an unconditional `text-white` for all ten
 * backgrounds, which put white type on four light chips. Measured on
 * /stats against the shipped palette: `movies` (amber-400) came out at
 * **1.72:1** and `activities` (sky-400) at **2.18:1** — both far below the
 * 4.5:1 WCAG AA floor for body text, and both legible in the product video.
 * `violet-500` was a quieter failure at 4.40:1.
 *
 * `fg` is whichever of black/white has the higher contrast ratio against
 * that background. The numbers below are computed from the Tailwind v4 sRGB
 * value of each class, and every pair now clears AA:
 *
 *   red-600    #e7000b  white 4.77  (black 4.40)
 *   orange-400 #ff8904  black 8.83  (white 2.38)
 *   amber-400  #ffb900  black 12.19 (white 1.72)
 *   lime-600   #5ea500  black 6.86  (white 3.06)
 *   green-700  #008236  white 4.95  (black 4.25)
 *   teal-600   #009689  black 5.72  (white 3.67)
 *   sky-400    #00bcff  black 9.64  (white 2.18)
 *   indigo-600 #4f39f6  white 6.46  (black 3.25)
 *   violet-500 #8e51ff  black 4.77  (white 4.40)
 *   rose-500   #ff2056  black 5.59  (white 3.75)
 *
 * If a background changes, recompute its pair — do not assume white.
 */
const PALETTE = [
  { bg: 'bg-red-600', fg: 'text-white' },
  { bg: 'bg-orange-400', fg: 'text-black' },
  { bg: 'bg-amber-400', fg: 'text-black' },
  { bg: 'bg-lime-600', fg: 'text-black' },
  { bg: 'bg-green-700', fg: 'text-white' },
  { bg: 'bg-teal-600', fg: 'text-black' },
  { bg: 'bg-sky-400', fg: 'text-black' },
  { bg: 'bg-indigo-600', fg: 'text-white' },
  { bg: 'bg-violet-500', fg: 'text-black' },
  { bg: 'bg-rose-500', fg: 'text-black' },
];

function getSwatchFromPalette(text: string) {
  const normalizedText = text.toLowerCase();

  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < normalizedText.length; i++) {
    hash ^= normalizedText.charCodeAt(i);
    hash *= FNV_PRIME;
  }

  const index = Math.abs(hash) % PALETTE.length;

  return PALETTE[index];
}
