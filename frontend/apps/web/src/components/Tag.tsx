import { useMemo } from 'react';

import { Badge } from '@ci/shadcn';

interface Props {
  text: string;
}

export function Tag({ text }: Props) {
  const color = useMemo(() => getColorFromPalette(text), [text]);

  return <Badge className={color}>{text}</Badge>;
}

const FNV_PRIME = 16777619;
const FNV_OFFSET_BASIS = 2166136261;
const PALETTE = [
  'bg-red-600',
  'bg-orange-400',
  'bg-amber-400',
  'bg-lime-600',
  'bg-green-700',
  'bg-teal-600',
  'bg-sky-400',
  'bg-indigo-600',
  'bg-violet-500',
  'bg-rose-500',
];

function getColorFromPalette(text: string) {
  const normalizedText = text.toLowerCase();

  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < normalizedText.length; i++) {
    hash ^= normalizedText.charCodeAt(i);
    hash *= FNV_PRIME;
  }

  const index = Math.abs(hash) % PALETTE.length;

  return PALETTE[index];
}
