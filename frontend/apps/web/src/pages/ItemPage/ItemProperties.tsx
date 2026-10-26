import { type ReactNode } from 'react';

import { type UnitSystem, formatDimensions, formatMass, formatTerm, formatVolume } from '@/lib/measurements';
import { formatThingDate } from '@/lib/thingDate';

/** Everything this panel can show. All optional — an item may know none of it. */
export interface ItemPhysicalProperties {
  category?: string | null;
  subcategory?: string | null;
  brand?: string | null;
  model?: string | null;
  condition?: string | null;
  quantity?: number | null;
  currentValue?: number | null;
  purchasePrice?: number | null;
  acquiredAt?: string | null;
  acquisitionMethod?: string | null;
  acquiredFrom?: string | null;
  manufacturedAt?: string | null;
  expiresAt?: string | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  massG?: number | null;
  volumeMl?: number | null;
  unitSystem?: string | null;
  colors?: string[] | null;
  colorHex?: string | null;
  materials?: string[] | null;
  composition?: Record<string, number> | null;
}

/** Enum values arrive SHOUTING from GraphQL; a person reads 'Like new'. */
function humanize(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const words = value.toLowerCase().replace(/_/g, ' ');

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `{cotton: 0.8}` → `Cotton 80%`, in descending order of how much of the object it is. */
function formatComposition(composition: Record<string, number> | null | undefined): string | null {
  const entries = Object.entries(composition ?? {});

  if (entries.length === 0) {
    return null;
  }

  return entries
    .sort(([, a], [, b]) => b - a)
    .map(([material, fraction]) => `${formatTerm(material)} ${Math.round(fraction * 100)}%`)
    .join(', ');
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/**
 * What the thing IS, as opposed to what it is called: size, weight, colour,
 * material and how it came to be owned.
 *
 * Rows render only when there is something to say — a half-known item shows the
 * three facts it has rather than a table of dashes, which is the difference
 * between a panel that looks empty and one that looks broken.
 */
export function ItemProperties({ item }: { item: ItemPhysicalProperties }) {
  const system: UnitSystem = item.unitSystem === 'IMPERIAL' ? 'imperial' : 'metric';

  const rows: Array<[string, ReactNode]> = [];
  const push = (label: string, value: ReactNode) => {
    if (value != null && value !== '') {
      rows.push([label, value]);
    }
  };

  push('Category', [humanize(item.category), humanize(item.subcategory)].filter(Boolean).join(' · '));
  push('Brand', [item.brand, item.model].filter(Boolean).join(' '));
  push('Condition', humanize(item.condition));
  push('Quantity', (item.quantity ?? 1) > 1 ? item.quantity : null);
  push('Size', formatDimensions(item, system));
  push('Weight', formatMass(item.massG, system));
  push('Capacity', formatVolume(item.volumeMl, system));

  const colors = item.colors?.map(formatTerm).join(', ');

  push(
    'Colour',
    colors ? (
      <span className="inline-flex items-center gap-2">
        {item.colorHex && (
          <span
            aria-hidden
            className="h-3 w-3 rounded-full border"
            style={{ backgroundColor: item.colorHex }}
          />
        )}
        {colors}
      </span>
    ) : null,
  );

  // Composition is the stricter statement of the same fact, so it replaces the
  // plain material list whenever the proportions are known.
  push('Made of', formatComposition(item.composition) ?? item.materials?.map(formatTerm).join(', '));
  push('Acquired', formatThingDate(item.acquiredAt));
  push('How', humanize(item.acquisitionMethod));
  push('From', item.acquiredFrom);
  push('Paid', item.purchasePrice == null ? null : `$${item.purchasePrice}`);
  push('Worth', item.currentValue == null ? null : `$${item.currentValue}`);
  push('Made', formatThingDate(item.manufacturedAt));
  push('Expires', formatThingDate(item.expiresAt));

  if (rows.length === 0) {
    return null;
  }

  return (
    <div>
      <h2 className="mb-1 text-sm font-medium">Properties</h2>
      <dl className="divide-y">
        {rows.map(([label, value]) => (
          <Row key={label} label={label}>
            {value}
          </Row>
        ))}
      </dl>
    </div>
  );
}
