import {
  Bot,
  CircleQuestionMark,
  CloudDownload,
  Inbox,
  ListTodo,
  Newspaper,
  Search,
  Share2,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from '@ci/shadcn/icons';

/**
 * One source of truth for how a job CATEGORY is named and coloured.
 *
 * The taxonomy already says which part of the appliance a job belongs to; this
 * turns that into something scannable. A wall of 8,000 identically-styled rows
 * hides exactly the thing an operator is looking for — "which subsystem is
 * busy/stuck?" — so category carries a colour in the table, in the filters and
 * on the schedules.
 *
 * Colours are Tailwind `-400` foregrounds on a `/10` tint of the same hue. That
 * pairing clears WCAG AA (≥4.5:1) on this dark surface, and every swatch is
 * ALWAYS accompanied by its text label — colour is a second channel here, never
 * the only one (WCAG 1.4.1).
 */
export const CATEGORY_LABELS: Record<string, string> = {
  search: 'Search index',
  ingest: 'Ingest',
  enrich: 'Enrichment',
  graph: 'Life graph',
  pipeline: 'Pipeline',
  import: 'Import / sync',
  llm: 'Model',
  personalization: 'Personalization',
  planning: 'Planning',
  maintenance: 'Maintenance',
  unclassified: 'Unclassified',
};

/** Badge/pill classes per category: text + tint + border, one hue each. */
export const CATEGORY_STYLES: Record<string, string> = {
  search: 'text-sky-400 bg-sky-400/10 border-sky-400/30',
  ingest: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30',
  enrich: 'text-violet-400 bg-violet-400/10 border-violet-400/30',
  graph: 'text-amber-400 bg-amber-400/10 border-amber-400/30',
  pipeline: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/30',
  import: 'text-orange-400 bg-orange-400/10 border-orange-400/30',
  llm: 'text-fuchsia-400 bg-fuchsia-400/10 border-fuchsia-400/30',
  personalization: 'text-rose-400 bg-rose-400/10 border-rose-400/30',
  planning: 'text-teal-400 bg-teal-400/10 border-teal-400/30',
  maintenance: 'text-slate-400 bg-slate-400/10 border-slate-400/30',
  unclassified: 'text-muted-foreground bg-muted/40 border-border',
};

/** Just the dot colour, for compact rows where a full pill is too heavy. */
export const CATEGORY_DOT: Record<string, string> = {
  search: 'bg-sky-400',
  ingest: 'bg-emerald-400',
  enrich: 'bg-violet-400',
  graph: 'bg-amber-400',
  pipeline: 'bg-cyan-400',
  import: 'bg-orange-400',
  llm: 'bg-fuchsia-400',
  personalization: 'bg-rose-400',
  planning: 'bg-teal-400',
  maintenance: 'bg-slate-400',
  unclassified: 'bg-muted-foreground',
};

/**
 * One icon per category, so a chip is recognisable before it is read.
 *
 * The icon is a THIRD channel, after the written label and the hue — never a
 * replacement for either. Every chip keeps its text, and each icon is
 * `aria-hidden`; an icon-only category row would be the first WCAG 1.4.1
 * violation on this page (see the note at the top of this file).
 *
 * Chosen for what the subsystem DOES, not for its module name: work arriving
 * (inbox), work being enriched (sparkles), the graph (share), the staged
 * pipeline (workflow), and so on.
 */
export const CATEGORY_ICON: Record<string, LucideIcon> = {
  search: Search,
  ingest: Inbox,
  enrich: Sparkles,
  graph: Share2,
  pipeline: Workflow,
  import: CloudDownload,
  llm: Bot,
  personalization: Newspaper,
  planning: ListTodo,
  maintenance: Wrench,
  unclassified: CircleQuestionMark,
};

/**
 * The bucket the server reports for a job whose event has no taxonomy entry.
 *
 * Mirrors `UNCLASSIFIED_CATEGORY` in the backend taxonomy. It is deliberately
 * not one of the ten real categories: it is the ABSENCE of a classification, and
 * a non-zero count is a gap in `domains/events/taxonomy.ts` rather than a kind
 * of work. It gets a chip anyway, because the alternative — measured live at 587
 * of 9,557 jobs — is a bucket the operator can see in the totals but cannot open.
 */
export const UNCLASSIFIED_CATEGORY = 'unclassified';

/**
 * Categories grouped by the part of the appliance they belong to.
 *
 * Ten flat chips is a wall, and on a real appliance four of them are usually
 * empty — so the row is ordered and separated by SYSTEM, following the data-flow
 * spine the appliance actually has: work arrives, the pipeline processes it, it
 * becomes recallable, the companion surfaces it, and upkeep runs beside all of
 * it. An operator triaging "which part is stuck?" reasons in these five buckets,
 * not in ten module names.
 *
 * This is a presentation grouping, not a second taxonomy: the wire format stays
 * one flat `category` string, so nothing here has to agree with the server
 * beyond the category keys themselves.
 */
export interface JobSystem {
  readonly key: string;
  readonly label: string;
  readonly categories: readonly string[];
}

export const JOB_SYSTEMS: readonly JobSystem[] = [
  { key: 'intake', label: 'Intake', categories: ['ingest', 'import'] },
  { key: 'processing', label: 'Processing', categories: ['pipeline', 'enrich'] },
  { key: 'recall', label: 'Recall', categories: ['search', 'graph'] },
  { key: 'companion', label: 'Companion', categories: ['llm', 'personalization', 'planning'] },
  // `unclassified` is deliberately NOT here. It is not a part of the appliance,
  // it is the absence of a classification, and filing it under Upkeep would say
  // an unknown event is a kind of housekeeping — the exact confusion that let
  // 586 live jobs render as "Maintenance" while the Maintenance filter returned
  // none of them. It gets its own chip after the systems, and only when it is
  // non-empty: a zero there means the taxonomy is complete, which is worth the
  // chip disappearing to say.
  { key: 'upkeep', label: 'Upkeep', categories: ['maintenance'] },
];

/** Every category, in the order the chip row lays them out. */
export const CATEGORIES_IN_SYSTEM_ORDER: readonly string[] = JOB_SYSTEMS.flatMap(
  (system) => system.categories,
);

/**
 * The same ten hues as {@link CATEGORY_DOT}, as literal colours.
 *
 * Recharts needs a value it can put in `stroke`/`fill`, not a Tailwind class,
 * and the two must not drift — a legend swatch that disagrees with the chip
 * above it is worse than no colour at all. These are Tailwind's own `-400`
 * values, the same step the class map uses, so the pairs stay identical by
 * construction rather than by eye.
 */
export const CATEGORY_CHART_COLOR: Record<string, string> = {
  search: '#38bdf8', // sky-400
  ingest: '#34d399', // emerald-400
  enrich: '#a78bfa', // violet-400
  graph: '#fbbf24', // amber-400
  pipeline: '#22d3ee', // cyan-400
  import: '#fb923c', // orange-400
  llm: '#e879f9', // fuchsia-400
  personalization: '#fb7185', // rose-400
  planning: '#2dd4bf', // teal-400
  maintenance: '#94a3b8', // slate-400
  unclassified: '#64748b', // slate-500 — deliberately duller than the ten real ones
};

export function categoryChartColor(category: string | null | undefined): string {
  return CATEGORY_CHART_COLOR[category ?? ''] ?? CATEGORY_CHART_COLOR.unclassified;
}

export function categoryLabel(category: string | null | undefined): string {
  return CATEGORY_LABELS[category ?? ''] ?? category ?? 'Unclassified';
}

export function categoryIcon(category: string | null | undefined): LucideIcon {
  return CATEGORY_ICON[category ?? ''] ?? CircleQuestionMark;
}

export function categoryStyle(category: string | null | undefined): string {
  return CATEGORY_STYLES[category ?? ''] ?? CATEGORY_STYLES.unclassified;
}

export function categoryDot(category: string | null | undefined): string {
  return CATEGORY_DOT[category ?? ''] ?? CATEGORY_DOT.unclassified;
}
