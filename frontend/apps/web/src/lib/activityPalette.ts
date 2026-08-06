import type { ScheduleEvent } from '@/api/useScheduleService';

/**
 * Colour for the week, in two readings.
 *
 * The grid can say two different things with hue, and they answer different
 * questions:
 *
 *   - `type`   — WHAT this is. Committed events and the rhythm layer share one
 *                vocabulary (HBPE's eight L0 classes), so a WORK block sitting
 *                under a WORK rhythm cell reads as one claim, not two.
 *   - `source` — WHERE it came from. Which synced calendar owns this hour.
 *
 * Only one is ever active. They are alternate encodings of the same marks, not
 * layers, because hue is a single channel and splitting it says neither thing.
 */
export type ColorMode = 'type' | 'source';

/**
 * HBPE's fixed L0 vocabulary (hbpe/src/ci/tokenizer/vocab_registry.py:L0_CLASSES).
 * Committed events are mapped onto it so both lanes speak the same language —
 * that shared vocabulary is the whole reason type-colouring is worth having.
 */
export const ACTIVITY_CLASSES = [
  'WORK',
  'EXERCISE',
  'SOCIAL',
  'ERRAND',
  'LEISURE',
  'TRANSIT',
  'SLEEP',
  'UNKNOWN',
] as const;

export type ActivityClass = (typeof ACTIVITY_CLASSES)[number];

/**
 * Palette slots, in the fixed order that makes them colourblind-separable.
 *
 * The order IS the safety mechanism and must not be permuted: it is the
 * validated default categorical order (blue, orange, aqua, yellow, magenta,
 * green, violet), verified with the dataviz validator against this app's own
 * card surfaces in both modes — worst adjacent CVD ΔE 9.1 light / 8.4 dark
 * (≥8 target), worst normal-vision ΔE 19.6 / 19.3 (≥15 floor).
 *
 * Seven hues carry the seven real classes; UNKNOWN is deliberately NOT a hue.
 * An unclassified block should recede, not claim an eighth identity.
 *
 * Deliberately absolute rather than derived from the user's theme hue (unlike
 * `--chart-1..5`, which rotate with it): a class's colour is a learned
 * association, and re-picking a theme must not repaint what WORK means. The
 * values are theme-independent but mode-dependent, so they live as CSS
 * variables in styles/index.css with `.dark` overrides.
 *
 * Contrast caveat: on the LIGHT surface, orange/aqua/yellow/magenta sit below
 * 3:1. That is legal here only because every chip carries its visible title and
 * the legend pairs each colour with a word — colour is never the sole carrier
 * of identity. Do not remove those labels.
 */
const CLASS_VAR: Record<ActivityClass, string> = {
  WORK: '--activity-1',
  EXERCISE: '--activity-2',
  SOCIAL: '--activity-3',
  ERRAND: '--activity-4',
  LEISURE: '--activity-5',
  TRANSIT: '--activity-6',
  SLEEP: '--activity-7',
  UNKNOWN: '--activity-none',
};

/** Human label for a class chip in the legend and tooltips. */
export const CLASS_LABEL: Record<ActivityClass, string> = {
  WORK: 'work',
  EXERCISE: 'exercise',
  SOCIAL: 'social',
  ERRAND: 'errands',
  LEISURE: 'leisure',
  TRANSIT: 'transit',
  SLEEP: 'sleep',
  UNKNOWN: 'unsorted',
};

/**
 * Connectors get a fixed slot rather than a position in the sorted set of
 * whatever happens to be on screen this week. Colour has to follow the source,
 * not its rank — otherwise connecting a new calendar silently repaints every
 * event you had already learned to recognise.
 */
const SOURCE_SLOT: Record<string, number> = {
  google: 1,
  gmail: 1,
  microsoft: 2,
  outlook: 2,
  apple: 3,
  icloud: 3,
  facebook: 4,
  signal: 5,
  spotify: 6,
  github: 7,
};

const SLOT_VAR = [
  '--activity-1',
  '--activity-2',
  '--activity-3',
  '--activity-4',
  '--activity-5',
  '--activity-6',
  '--activity-7',
] as const;

/** Events minted here carry no source; they are the neutral case, not a colour. */
export const LOCAL_SOURCE = 'here';

/** Stable slot for a connector we have no fixed entry for. */
function hashedSlot(source: string): number {
  let hash = 0;

  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }

  return (hash % SLOT_VAR.length) + 1;
}

/** The CSS variable a source's colour lives in. */
function sourceVar(source: string): string {
  if (source === LOCAL_SOURCE) {
    return '--activity-none';
  }

  const key = source.toLowerCase();
  const fixed = Object.entries(SOURCE_SLOT).find(([name]) => key.includes(name))?.[1];

  return SLOT_VAR[(fixed ?? hashedSlot(key)) - 1];
}

/**
 * Keyword → class. Consulted only after `category` fails to name a class
 * outright, and applied against `category` first, then the title.
 *
 * Ordered most- to least-specific, and whichever pattern sits earlier wins.
 * Titles are user prose, so this is a heuristic and is allowed to be wrong — an
 * unmatched event lands in UNKNOWN and recedes, which is a better failure than a
 * confident miscolour.
 *
 * The one place that ordering bit is the noun "run". English uses "<errand> run"
 * for exactly the thing EXERCISE is not, and because EXERCISE sits above ERRAND
 * the bare `run` alternative swallowed all of them: on real data a weekly
 * "Grocery Run" rendered as an exercise chip and announced itself as one in its
 * own accessible name. The errand sense therefore gets its own pattern ABOVE
 * EXERCISE — which is also what makes this docstring's "coffee run" example
 * true, rather than aspirational as it was.
 */
const CLASS_PATTERNS: Array<[RegExp, ActivityClass]> = [
  [/\b(sleep|nap|bedtime|rest)\b/, 'SLEEP'],
  // "<errand> run" before EXERCISE claims the word — see the note above.
  [/\b(grocery|grocer|groceries|coffee|school|beer|milk|supply|supplies|errand)\s+run\b/, 'ERRAND'],
  [
    /\b(flight|flights|travel|transit|commute|train|drive|driving|airport|taxi|uber|departs?|arrives?)\b/,
    'TRANSIT',
  ],
  [/\b(gym|workout|exercise|run|running|yoga|pilates|swim|swimming|training|ride|climb|lift)\b/, 'EXERCISE'],
  [
    /\b(standup|stand-up|sync|1:1|one-on-one|retro|sprint|backlog|grooming|review|interview|deadline|strategy|planning|kickoff|demo|meeting|work)\b/,
    'WORK',
  ],
  [
    /\b(doctor|dentist|appointment|errand|errands|shopping|grocery|groceries|grocer|bank|pharmacy|pickup|pick-up|drop-?off|repair|haircut|dmv)\b/,
    'ERRAND',
  ],
  [/\b(dinner|lunch|brunch|drinks|party|birthday|wedding|social|catch-?up|coffee|date)\b/, 'SOCIAL'],
  [
    /\b(movie|film|cinema|game|gaming|read|reading|music|concert|show|theatre|theater|holiday|vacation|leisure)\b/,
    'LEISURE',
  ],
];

const CLASS_SET = new Set<string>(ACTIVITY_CLASSES);

/**
 * Which activity class a committed event belongs to.
 *
 * `category` is checked first and, when it already names an L0 class, taken at
 * its word — that is the path HBPE-labelled rows travel. Everything else is
 * keyword inference over category then title.
 */
export function classifyEvent(event: Pick<ScheduleEvent, 'category' | 'title'>): ActivityClass {
  const category = event.category?.trim() ?? '';
  const upper = category.toUpperCase();

  if (CLASS_SET.has(upper)) {
    return upper as ActivityClass;
  }

  for (const haystack of [category, event.title ?? '']) {
    // `ci.events.category` is snake_case ('gym_workout', 'team_standup') and an
    // underscore is a word character, so `\bgym\b` does NOT match inside
    // `gym_workout`. Flatten separators to spaces first or every snake_case
    // category silently falls through to title inference.
    const text = haystack.toLowerCase().replace(/[_\-./]+/g, ' ');

    if (!text) {
      continue;
    }

    for (const [pattern, cls] of CLASS_PATTERNS) {
      if (pattern.test(text)) {
        return cls;
      }
    }
  }

  return 'UNKNOWN';
}

/** The rhythm layer already carries a class; normalise anything unexpected. */
export function normalizeClass(raw: string | null | undefined): ActivityClass {
  const upper = raw?.trim().toUpperCase() ?? '';

  return CLASS_SET.has(upper) ? (upper as ActivityClass) : 'UNKNOWN';
}

/** The source key an event is coloured by. */
export function sourceOf(event: Pick<ScheduleEvent, 'sourceSystem'>): string {
  return event.sourceSystem?.trim() || LOCAL_SOURCE;
}

/**
 * The CSS colour an event takes under the active mode. Returned as a
 * `var(--…)` reference rather than a hex so the light/dark steps swap with the
 * theme class and never need to be recomputed here.
 */
export function eventColor(event: ScheduleEvent, mode: ColorMode): string {
  const variable = mode === 'source' ? sourceVar(sourceOf(event)) : CLASS_VAR[classifyEvent(event)];

  return `var(${variable})`;
}

/** The CSS colour for a rhythm cell of a given class. */
export function classColor(cls: ActivityClass): string {
  return `var(${CLASS_VAR[cls]})`;
}

/** The CSS colour for a legend swatch in source mode. */
export function sourceColor(source: string): string {
  return `var(${sourceVar(source)})`;
}

/**
 * Chip fill: the hue mixed down into the card so a row of blocks reads as
 * tinted glass rather than a wall of saturated bars. The accent bar and border
 * carry the identity; the fill only has to be enough to group them.
 */
export function chipFill(color: string): string {
  return `color-mix(in oklab, ${color} 20%, var(--card))`;
}

/** Chip border: the same hue, strong enough to hold an edge against the fill. */
export function chipBorder(color: string): string {
  return `color-mix(in oklab, ${color} 55%, transparent)`;
}
