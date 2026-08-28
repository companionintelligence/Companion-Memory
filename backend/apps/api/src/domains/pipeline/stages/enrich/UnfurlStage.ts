import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The embed domain's PUBLIC barrel. `UnfurlService` owns the cache
// (`ci.unfurls`), the per-host throttle, the three resolvers and the poster
// copy; `resolveTargetFor` is the pure key derivation the GraphQL loader also
// uses, so what this stage resolves is exactly what the UI later looks up.
import { resolveTargetFor, UnfurlService, type ResolveTarget } from '@ci/domains/embed';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { stageVersion } from '../../versions';

/**
 * Applicability, NOT completion: a content row that carries something a
 * resolver can act on — a link, a provider handle in external_id, or a
 * streaming-export title. It never mentions `ci.unfurls` (the table the stage
 * fills) nor the ledger, so a version bump re-opens every row.
 */
export const UNFURL_SOURCE: StageSource = {
  schema: 'ci',
  table: 'content',
  idColumn: 'id',
  userColumn: 'user_id',
  // YouTube is excluded up front rather than at resolve time: its poster and
  // player are templated from the id (`resolveTargetFor` returns null), and
  // a 70k-row watch history is 70k `skipped` ledger rows for nothing. A
  // YouTube link from another source (a Chrome bookmark) still comes through
  // and takes the cheap `no_resolve_target` skip.
  predicate:
    `(s.source_system IS DISTINCT FROM 'youtube' AND (s.url IS NOT NULL OR s.source_url IS NOT NULL ` +
    `OR s.external_id_kind = 'external_uri' ` +
    `OR s.source_system IN ('netflix', 'prime_video')))`,
};

interface ContentRow {
  id: string;
  source_system: string | null;
  url: string | null;
  source_url: string | null;
  external_id: string | null;
  external_id_kind: string | null;
  source_title: string | null;
}

/**
 * `enrich.unfurl` — resolve what a content row's link points at (title,
 * author, poster, duration, Wikidata id) into `ci.unfurls`.
 *
 * One network call per DISTINCT resolve key, not per row: the slice is
 * grouped by key first, `UnfurlService` answers fresh cache rows without a
 * request, and every row sharing a key gets the same result. A `blocked`
 * answer (private address, denied host) is a `skipped`, not a `failed` —
 * retrying it would be the SSRF.
 */
@Injectable()
export class UnfurlStage implements Stage {
  readonly id = STAGE_IDS.ENRICH_UNFURL;

  readonly version = stageVersion(STAGE_IDS.ENRICH_UNFURL);

  /** External providers + object storage for the poster copy. */
  readonly queue = PIPELINE_QUEUES.ENRICH;

  readonly entityTypes = ['content'] as const;

  readonly source = UNFURL_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly unfurlService: UnfurlService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(UnfurlStage.name);
  }

  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();
    if (ids.length === 0) {
      return results;
    }

    const rows = await this.dataSource.query<ContentRow[]>(
      `SELECT c.id, c.source_system, c.url, c.source_url, c.external_id, c.external_id_kind,
              c.source_data->>'Title' AS source_title
         FROM ci.content c
        WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2::uuid`,
      [ids, ctx.userId],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const id of ids) {
      if (!byId.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const targets = new Map<string, ResolveTarget>();
    const idsByKey = new Map<string, string[]>();
    for (const row of rows) {
      const target = resolveTargetFor({
        sourceSystem: row.source_system,
        url: row.url,
        sourceUrl: row.source_url,
        externalId: row.external_id,
        externalIdKind: row.external_id_kind,
        sourceTitle: row.source_title,
      });
      if (!target) {
        results.set(row.id, { outcome: 'skipped', reason: 'no_resolve_target' });
        continue;
      }

      targets.set(target.key, target);
      idsByKey.set(target.key, [...(idsByKey.get(target.key) ?? []), row.id]);
    }

    if (targets.size === 0) {
      return results;
    }

    const resolved = await this.unfurlService.resolveMany(ctx, [...targets.values()]);

    for (const [key, rowIds] of idsByKey) {
      const outcome = resolved.get(key);
      const result = this.toStageResult(outcome);
      for (const id of rowIds) {
        results.set(id, result);
      }
    }

    return results;
  }

  private toStageResult(
    outcome: ReturnType<UnfurlService['resolveMany']> extends Promise<Map<string, infer R>>
      ? R | undefined
      : never,
  ): StageResult {
    if (!outcome) {
      return { outcome: 'failed', reason: 'resolver_no_answer' };
    }

    switch (outcome.kind) {
      case 'unconfigured':
        // Not stored, not failed: the first sweep after the key lands resolves it.
        return { outcome: 'skipped', reason: outcome.detail };
      case 'disabled':
        return { outcome: 'skipped', reason: outcome.detail };
      case 'row':
        break;
    }

    switch (outcome.row.status) {
      case 'ok':
        return { outcome: 'done' };
      case 'not_found':
      case 'not_embeddable':
      case 'blocked':
        // Definitive answers. The cache row carries the detail; the ledger the verdict.
        return { outcome: 'skipped', reason: outcome.row.status };
      case 'rate_limited':
      case 'transport_error':
        // The world, not the row: retried on the ledger's backoff, and the
        // cache row's own expiry keeps a second sweep from hammering the host.
        return { outcome: 'failed', reason: 'provider_unavailable' };
      default:
        return { outcome: 'failed', reason: 'unknown_status' };
    }
  }
}
