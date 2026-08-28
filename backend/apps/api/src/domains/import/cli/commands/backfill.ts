import type { OrchestrateStage } from '@ci/domains/maintenance';

import { CliError, type CliContext } from '../context';
import { duration, json, table } from '../output';

/**
 * The canonical leg list, in the order the orchestrator runs it.
 *
 * Declared as a `Record<OrchestrateStage, …>` rather than a plain array so the
 * COMPILER enforces the correspondence both ways: a leg added to the
 * orchestrator and forgotten here is a missing key, and a name misspelled here
 * is an excess one. A hand-maintained array would take neither complaint, and
 * the failure it hides is the quiet kind — `--list` under-reporting what the
 * appliance can actually do, or a stage name the server 400s on.
 *
 * The values are the one-line descriptions `--list` prints. Order is insertion
 * order, which is the canonical order; the server runs it canonically whatever
 * order the request names.
 */
const STAGE_HELP: Record<OrchestrateStage, string> = {
  extract_people: 'Create Person stubs from communication participants',
  link_communications: 'Link communications to the people who sent and received them',
  link_events: 'Fill event organizer and participant references',
  heal_self_collation: 'Fold owner-representing Person stubs into the self Person when trust allows',
  materialize_edges: 'Materialize the deterministic graph edges',
  normalize_relationships: 'Normalize relationship rows onto the canonical vocabulary',
  derive_relationships: 'Derive relationships implied by the normalized ones',
  fold_notes: 'Fold note content into its canonical record',
  extract_graph: 'LLM graph extraction over communications and events',
  geocode: 'Forward-geocode events that name a place but have no coordinates',
  reverse_geocode: 'Name the places of events that have coordinates but no label',
  reverse_position: 'Reverse-geocode GPS points on ci.position into address fields',
  reverse_object: 'Reverse-geocode object coordinates onto last_seen_place_entity_id',
  estimate_locations: 'Estimate coordinates for events from surrounding located ones',
  media_dimensions: 'Backfill width, height and duration for stored media',
  search_index: 'Embed everything the search index has not embedded yet',
  backfill_summaries:
    'Generate hourly/daily/weekly/monthly summaries for historical (bulk-imported) activity',
};

export const BACKFILL_STAGES = Object.keys(STAGE_HELP) as OrchestrateStage[];

export interface BackfillOptions {
  list?: boolean;
  /** Stop at the first leg that errors. Default is fail-soft: report and carry on. */
  abortOnError?: boolean;
  json?: boolean;
}

/**
 * Post-import enrichment: the successor to upstream's four backfill commands.
 *
 * Upstream shipped `backfill-contacts`, `backfill-identity`, `backfill-calendar`
 * and `dedupe-media` — each a repair for a defect in its own SQLite mirror, and
 * none of them portable, because the mirror is gone and the defects with it.
 * What replaced them is not a rename but a different shape: `ci.*` has a real
 * enrichment chain (people from communications, links, graph edges, geocoding,
 * embeddings), the orchestrator runs it in canonical order with per-leg
 * reporting, and this command drives that.
 *
 * Fail-soft by default, which is the orchestrator's own default and the right
 * one for a chain: a geocoder that cannot reach its provider should not cost you
 * the embeddings.
 */
export async function backfillCommand(
  ctx: CliContext,
  stages: readonly string[],
  options: BackfillOptions = {},
): Promise<void> {
  if (options.list) {
    if (options.json) {
      json(
        ctx.term,
        BACKFILL_STAGES.map((stage) => ({ stage, description: STAGE_HELP[stage] })),
      );

      return;
    }

    ctx.term.out(
      table(BACKFILL_STAGES, [
        { header: 'stage', value: (stage) => stage },
        { header: 'what it does', value: (stage) => STAGE_HELP[stage] },
      ]),
    );
    ctx.term.out('\nNaming none runs them all, in this order.');

    return;
  }

  const unknown = stages.filter((stage) => !(BACKFILL_STAGES as string[]).includes(stage));

  if (unknown.length > 0) {
    throw new CliError(`Unknown stage(s): ${unknown.join(', ')}. See \`ci-import backfill --list\`.`);
  }

  if (!options.json) {
    ctx.term.out(
      `Running ${stages.length === 0 ? BACKFILL_STAGES.length : stages.length} leg(s). ` +
        `This is synchronous and can take hours — search_index alone embeds every unembedded record.`,
    );
  }

  const summary = await ctx.client.orchestrate(
    stages.length === 0 ? undefined : (stages as OrchestrateStage[]),
    {
      abortOnError: options.abortOnError,
      onLine: (line) => {
        if (options.json) {
          return;
        }

        if (line.type === 'leg-start') {
          ctx.term.out(`→ ${String(line.leg)} (${String(line.index)}/${String(line.of)})`);
        } else if (line.type === 'leg-error') {
          ctx.term.err(`  ${String(line.leg)}: ${String(line.error)}`);
        }
      },
    },
  );

  if (options.json) {
    json(ctx.term, summary);
  } else {
    ctx.term.out('');
    ctx.term.out(
      table(summary.legs, [
        { header: 'leg', value: (leg) => leg.leg },
        { header: 'ok', value: (leg) => (leg.ok ? 'yes' : 'no') },
        { header: 'took', value: (leg) => duration(leg.durationMs), align: 'right' },
        { header: 'detail', value: (leg) => describeLeg(leg.result, leg.error) },
      ]),
    );
    ctx.term.out(
      `\n${summary.ok ? 'All legs ok' : 'Some legs failed'} in ${duration(summary.totalDurationMs)}.`,
    );
  }

  if (!summary.ok) {
    throw new CliError('One or more enrichment legs failed.', 1);
  }
}

/** A leg's result object as one short cell — full detail is `--json`'s job. */
function describeLeg(result: object | undefined, error: string | undefined): string {
  if (error != null) {
    return error.slice(0, 60);
  }

  if (result == null) {
    return '';
  }

  return Object.entries(result)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}
