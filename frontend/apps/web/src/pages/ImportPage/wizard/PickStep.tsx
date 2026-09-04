import { type CSSProperties, useMemo, useState } from 'react';

import { Badge, Button, cn, Input } from '@ci/shadcn';
import { Check, Search } from '@ci/shadcn/icons';

import { compactNumber } from '../runFormat';
import type { CatalogSource } from '../useImportApi';

import { ECOSYSTEM_ICONS, pickableSections } from './sources';
import { countFor, useObjectCounts } from './useObjectCounts';
import { unambiguousImporters, useSourceUsage } from './useSourceUsage';

export interface PickStepProps {
  catalog: readonly CatalogSource[];
  picked: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onContinue: () => void;
  /** When true (default), Continue stays pinned and only the catalog scrolls. */
  pinContinue?: boolean;
}

/**
 * Step 1: which ecosystems do you use?
 *
 * A grid of recognizable brands grouped into sections, because the person
 * answering has never heard of an "importer" — they know they use Spotify. A
 * source whose parser is not written yet is still shown, badged "coming soon":
 * "we know this service and haven't finished it" is a materially different
 * answer from silence, which reads as unsupported.
 */
export function PickStep({ catalog, picked, onToggle, onContinue, pinContinue = true }: PickStepProps) {
  const [logoFailed, setLogoFailed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const lastImportedAt = useSourceUsage();
  const objectCounts = useObjectCounts(catalog);
  const ownedImporters = useMemo(() => unambiguousImporters(catalog), [catalog]);

  const sections = useMemo(() => pickableSections(catalog), [catalog]);

  // The filter matches a tile's own name AND the member names a bundle tile
  // carries — typing "gmail" must surface the Google tile, not an empty grid.
  // Sections with no surviving tiles disappear whole; an empty heading reads
  // as "everything here was taken away".
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
      return sections;
    }

    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          [item.label, ...(item.memberNames ?? [])].some((name) => name.toLowerCase().includes(needle)),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [sections, query]);

  return (
    // Contained hosts pin Continue and scroll only the catalog. The sources
    // page is not one of those: its host column scrolls the header, steps,
    // search and catalog together, so pinContinue is false there.
    <div className={cn('flex flex-col gap-5', pinContinue && 'h-full min-h-0')}>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search services…"
          aria-label="Search services"
          className="pl-8"
        />
      </div>

      <div
        data-testid="pick-catalog"
        className={cn('space-y-5', pinContinue && 'min-h-0 flex-1 overflow-y-auto')}
      >
        {visible.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No services match “{query.trim()}”. Anything can still be imported from the Upload tab —
            unrecognized files land as documents.
          </p>
        )}
        {visible.map((section) => (
          <section key={section.key} className="space-y-2.5">
            {/* Bigger and bolder than the card names below, in the section's
                own hue: as small muted text the headings sank between the
                brand logos and the grid read as one undifferentiated wall.
                The lighter dark-mode tone keeps the same hue legible on a
                dark ground. The rule after the label carries the colour
                across the row so the boundary reads even where the label is
                short. */}
            <h3
              className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-[var(--section-accent)] dark:text-[var(--section-accent-dark)]"
              style={
                {
                  '--section-accent': `oklch(0.5 0.17 ${section.hue})`,
                  '--section-accent-dark': `oklch(0.8 0.13 ${section.hue})`,
                } as CSSProperties
              }
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-current/12 [&>svg]:h-4 [&>svg]:w-4">
                {section.icon}
              </span>
              {section.label}
              <span aria-hidden className="ml-1 h-px min-w-6 flex-1 bg-current/25" />
            </h3>

            {/* Three to a row, matching every other gallery on the page. */}
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {section.items.map((item) => {
                const on = picked.has(item.key);
                const showLogo = item.logo != null && !logoFailed.has(item.key);
                // Newest across the importers this tile covers — and only the
                // ones it owns outright, since a shared parser cannot say WHICH
                // of its services an import came from.
                const imported = item.importers
                  .filter((importer) => ownedImporters.has(importer))
                  .map((importer) => lastImportedAt.get(importer))
                  .filter((at): at is string => at != null)
                  .sort()
                  .at(-1);
                // Kinds wrap into extra columns as they accumulate — a second
                // at five, a third at nine — so a rich bundle stays shallow
                // without ever dropping a kind.
                const chipColumns = item.objects.length > 8 ? 3 : item.objects.length > 4 ? 2 : 1;

                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      aria-pressed={on}
                      title={item.ready ? item.label : `${item.label} — importer coming soon`}
                      onClick={() => onToggle(item.key)}
                      className={cn(
                        'relative flex h-full w-full flex-col gap-3 rounded-md border p-3 text-left text-sm transition-colors',
                        // Selection is the ONLY state that colors the card.
                        // Previously-imported tiles also got a tinted border and
                        // a corner check, and three of those on an unselected
                        // grid read as "already picked" — that state now lives
                        // solely in the dated line at the tile's foot.
                        on ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                        !item.ready && 'opacity-60',
                      )}
                    >
                      <span className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white p-1.5 ring-1 ring-black/5 text-muted-foreground [&>svg]:h-5 [&>svg]:w-5">
                          {showLogo ? (
                            <img
                              src={item.logo!}
                              alt=""
                              className="h-full w-full object-contain"
                              onError={() => setLogoFailed((previous) => new Set(previous).add(item.key))}
                            />
                          ) : (
                            (ECOSYSTEM_ICONS[item.ecosystem] ?? null)
                          )}
                        </span>

                        <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>

                        {on ? (
                          <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                        ) : !item.ready ? (
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            Coming soon
                          </Badge>
                        ) : null}
                      </span>

                      {item.memberNames != null && item.memberNames.length > 0 && (
                        // The services this one download stands for, by name —
                        // someone scanning the grid for "Instagram" must find
                        // it on the Meta tile, not conclude it is unsupported.
                        <span className="text-xs text-muted-foreground">{item.memberNames.join(' · ')}</span>
                      )}

                      {item.objects.length > 0 && (
                        // Filled column-first, so the vocabulary order reads
                        // down each column and then across.
                        <span
                          className={
                            chipColumns === 1
                              ? 'flex flex-col gap-1'
                              : cn(
                                  'grid grid-flow-col gap-x-3 gap-y-1',
                                  chipColumns === 2 ? 'grid-cols-2' : 'grid-cols-3',
                                )
                          }
                          style={
                            chipColumns === 1
                              ? undefined
                              : {
                                  gridTemplateRows: `repeat(${Math.ceil(item.objects.length / chipColumns)}, auto)`,
                                }
                          }
                        >
                          {item.objects.map((object) => {
                            // A bundle sums its members' real counts; a single
                            // service reads its own. `undefined` — never `0` —
                            // for a kind nobody has imported yet, or one this
                            // feature cannot honestly count (see
                            // ObjectCountService's disclosed gaps): a never-
                            // imported tile showing "0 Mail" next to every
                            // object it carries would be noise, not signal.
                            const count = countFor(objectCounts, item.importers, object.label);

                            return (
                              <span
                                key={object.label}
                                className="flex items-center gap-2 text-xs text-muted-foreground"
                              >
                                <object.icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                                <span className="truncate">
                                  {count != null ? `${compactNumber(count)} ${object.label}` : object.label}
                                </span>
                              </span>
                            );
                          })}
                        </span>
                      )}

                      {/* The difference between "I could import this" and "I
                          already did, in March" — which is what stops someone
                          re-importing an archive they have. How MUCH it brought
                          is a fact about the run, and lives on the run. */}
                      {imported && (
                        <span className="mt-auto flex items-center gap-1 pt-1 text-xs text-green-700 dark:text-green-400">
                          <Check aria-hidden className="h-3 w-3 shrink-0" />
                          imported{' '}
                          {new Date(imported).toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {catalog.length === 0 && <p className="text-sm text-muted-foreground">Loading services…</p>}
      </div>

      {/* Always reachable, deliberately.

          The service list is ~100 entries — 2,300px against a 290px viewport
          when this surface is embedded in onboarding. With the button at the
          end of that list, you picked a service at the top and the control
          that acts on your pick was two thousand pixels below the fold, while
          onboarding's own "Next" sat permanently visible directly beneath the
          surface and did the opposite thing: skip the step. Two buttons, and
          the reachable one was wrong.

          Contained hosts pin it outside their own scroll region via the flex
          split above. Page hosts (/sources/import) scroll this whole surface
          in one column, so there the row is sticky to the bottom of that
          scrollport instead — same guarantee, the host's scroll model.
          Translucent-blurred like the onboarding banner so catalog tiles
          sliding beneath it read as "more below", not a hard cut. */}
      <div
        className={cn(
          'flex shrink-0 justify-end border-t pt-4',
          !pinContinue && 'sticky bottom-0 z-10 bg-background/95 pb-3 backdrop-blur-sm',
        )}
      >
        <Button disabled={picked.size === 0} onClick={onContinue}>
          Continue → {picked.size} selected
        </Button>
      </div>
    </div>
  );
}
