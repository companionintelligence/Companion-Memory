import crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit from 'p-limit';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { isOutboundEnabled } from '@ci/common/outbound';
import config from '@ci/configuration';
import { FileService, FileVariant } from '@ci/domains/files';

import { UnfurlEntity } from '../entities/UnfurlEntity';
import type { ResolveTarget, Resolver } from '../resolveKey';
import { OEmbedResolver } from '../resolvers/OEmbedResolver';
import { OpenGraphResolver } from '../resolvers/OpenGraphResolver';
import type { UnfurlData, UnfurlOutcome, UnfurlResolver, UnfurlStatus } from '../resolvers/types';
import { WikidataResolver } from '../resolvers/WikidataResolver';

import { MAX_IMAGE_BYTES, UnfurlFetcher } from './UnfurlFetcher';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an answer stands before a sweep may re-ask the provider. */
const TTL_MS: Record<UnfurlStatus, number> = {
  ok: 30 * DAY_MS,
  not_found: 7 * DAY_MS,
  not_embeddable: 7 * DAY_MS,
  blocked: 30 * DAY_MS,
  // Short: the ledger retries these on its own backoff, and a cache row that
  // outlives that retry would answer it with the stale refusal instead of
  // letting the provider be asked again.
  transport_error: 60 * 60 * 1000,
  rate_limited: 15 * 60 * 1000,
};

/** In-flight ceiling inside one slice, independent of the per-host QPS throttle. */
const MAX_CONCURRENCY = 4;

/**
 * What a resolve produced for one key — stored row, or a reason no row was
 * written.
 *
 * `disabled` and `held` are both "nothing was fetched" and they are NOT the same
 * answer, which is why they are two kinds:
 *
 *  - `disabled` is the operator's configuration (`UNFURL_ENABLED=false`,
 *    `UNFURL_OPEN_GRAPH=false`). It is a property of the deployment and it is
 *    recorded as a terminal `skipped`, as it always has been.
 *  - `held` is the USER's switch (Settings -> Privacy -> "What leaves your
 *    appliance", key `link_previews`). It is temporary by definition — the user
 *    can turn it back on tomorrow — so it must never be written as a terminal
 *    verdict. `UnfurlStage` records it as a transient failure (refunded, retried)
 *    and `PipelineControlService` does not even start the stage while it holds.
 */
export type ResolveResult =
  | { kind: 'row'; row: UnfurlEntity; fresh: boolean }
  | { kind: 'unconfigured'; detail: string }
  | { kind: 'disabled'; detail: string }
  | { kind: 'held'; detail: string };

@Injectable()
export class UnfurlService {
  private readonly resolvers: Record<Resolver, UnfurlResolver>;

  private readonly limiter = plimit(MAX_CONCURRENCY);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fetcher: UnfurlFetcher,
    private readonly fileService: FileService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(UnfurlService.name);
    this.resolvers = {
      oembed: new OEmbedResolver(),
      wikidata: new WikidataResolver(),
      opengraph: new OpenGraphResolver(),
    };
  }

  /** Cached rows for a set of keys, fresh or not — the read path never fetches. */
  async findByKeys(ctx: UserServiceContext, keys: string[]): Promise<Map<string, UnfurlEntity>> {
    if (keys.length === 0) {
      return new Map();
    }

    const rows = await this.dataSource
      .getRepository(UnfurlEntity)
      .createQueryBuilder('u')
      .where('u.user_id = :userId', { userId: ctx.userId })
      .andWhere('u.resolve_key IN (:...keys)', { keys })
      .getMany();

    return new Map(rows.map((r) => [r.resolveKey, r]));
  }

  /**
   * Resolves every target once: a fresh cache row answers without a request;
   * anything else goes to its resolver under the per-host throttle, is
   * upserted, and — when it produced a thumbnail — gets a local poster copy.
   * Never throws for a single target; the map is complete on return.
   */
  async resolveMany(ctx: UserServiceContext, targets: ResolveTarget[]): Promise<Map<string, ResolveResult>> {
    const out = new Map<string, ResolveResult>();
    const unique = new Map(targets.map((t) => [t.key, t]));
    const cached = await this.findByKeys(ctx, [...unique.keys()]);
    const now = Date.now();
    const pending: ResolveTarget[] = [];

    // The user's switch, read once for the whole call. It gates every path in
    // here that would contact a host — a provider lookup AND the poster repair
    // below, which fetches the remote thumbnail — while cached rows are still
    // answered from Postgres: reading what is already stored sends nothing.
    const userAllowsFetching = isOutboundEnabled('link_previews');

    const posterless: UnfurlEntity[] = [];
    for (const [key, target] of unique) {
      const row = cached.get(key);
      if (row && (!row.expiresAt || row.expiresAt.getTime() > now)) {
        out.set(key, { kind: 'row', row, fresh: false });
        if (
          userAllowsFetching &&
          row.status === 'ok' &&
          row.thumbnailUrl &&
          !row.posterFileId &&
          config.unfurl.cachePosters
        ) {
          // A good answer whose poster copy is missing (an earlier failure, or
          // caching switched on later): repair it without re-asking the provider.
          posterless.push(row);
        }

        continue;
      }

      if (!config.unfurl.enabled) {
        out.set(key, { kind: 'disabled', detail: 'unfurl_disabled' });
        continue;
      }

      if (target.resolver === 'opengraph' && !config.unfurl.openGraph) {
        out.set(key, { kind: 'disabled', detail: 'open_graph_disabled' });
        continue;
      }

      // After the operator's settings, on purpose: a `disabled` answer is a
      // terminal verdict and this one is not, so when both apply the operator's
      // wins and keeps its existing (terminal) treatment.
      if (!userAllowsFetching) {
        out.set(key, { kind: 'held', detail: 'link_previews_off' });
        continue;
      }

      pending.push(target);
    }

    await Promise.all(
      posterless.map((row) =>
        this.limiter(async () => {
          const posterId = await this.cachePoster(ctx, row).catch(() => null);
          if (posterId) {
            row.posterFileId = posterId;
            await this.dataSource.query(
              `UPDATE ci.unfurls SET poster_file_id = $2, updated_at = now() WHERE id = $1`,
              [row.id, posterId],
            );
          }
        }),
      ),
    );

    await Promise.all(
      pending.map((target) =>
        this.limiter(async () => {
          try {
            out.set(target.key, await this.resolveOne(ctx, target, cached.get(target.key)));
          } catch (e) {
            // A bug in a resolver must not take the slice down with it.
            this.logger.warn('Unfurl resolver threw', { key: target.key, error: (e as Error).message });
            out.set(target.key, {
              kind: 'row',
              row: await this.upsert(
                ctx,
                target,
                { status: 'transport_error', detail: 'resolver_threw' },
                cached.get(target.key),
              ),
              fresh: true,
            });
          }
        }),
      ),
    );

    return out;
  }

  private async resolveOne(
    ctx: UserServiceContext,
    target: ResolveTarget,
    previous?: UnfurlEntity,
  ): Promise<ResolveResult> {
    // Pacing lives in the fetcher, per request and per provider bucket.
    const outcome = await this.resolvers[target.resolver].resolve(target, this.fetcher);
    if (outcome.status === 'unconfigured') {
      return { kind: 'unconfigured', detail: outcome.detail };
    }

    const row = await this.upsert(ctx, target, outcome, previous);

    if (outcome.status === 'ok' && row.thumbnailUrl && !row.posterFileId && shouldCachePoster(target)) {
      const posterId = await this.cachePoster(ctx, row);
      if (posterId) {
        row.posterFileId = posterId;
        await this.dataSource.query(
          `UPDATE ci.unfurls SET poster_file_id = $2, updated_at = now() WHERE id = $1`,
          [row.id, posterId],
        );
      }
    }

    return { kind: 'row', row, fresh: true };
  }

  private async upsert(
    ctx: UserServiceContext,
    target: ResolveTarget,
    outcome: Exclude<UnfurlOutcome, { status: 'unconfigured' }>,
    previous?: UnfurlEntity,
  ): Promise<UnfurlEntity> {
    const data: UnfurlData = outcome.status === 'ok' ? outcome.data : {};
    const failed = outcome.status === 'transport_error' || outcome.status === 'rate_limited';
    const failureCount = failed ? (previous?.failureCount ?? 0) + 1 : 0;
    // Back off repeat failures: 1d, 2d, 4d … capped at the ok TTL.
    const ttl = failed
      ? Math.min(TTL_MS[outcome.status] * 2 ** Math.min(failureCount - 1, 5), TTL_MS.ok)
      : TTL_MS[outcome.status];
    const payload = {
      ...(data.payload ?? {}),
      ...(outcome.status !== 'ok' && outcome.detail ? { detail: outcome.detail } : {}),
    };

    const rows = await this.dataSource.query<UnfurlEntity[]>(
      `INSERT INTO ci.unfurls (
         user_id, resolve_key, resolver, status, title, author_name, author_url, site_name,
         description, canonical_url, thumbnail_url, duration_seconds, external_ref, payload,
         failure_count, fetched_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, now(), now() + ($16::bigint * interval '1 millisecond'))
       ON CONFLICT (user_id, resolve_key) DO UPDATE SET
         resolver = EXCLUDED.resolver,
         status = EXCLUDED.status,
         title = COALESCE(EXCLUDED.title, ci.unfurls.title),
         author_name = COALESCE(EXCLUDED.author_name, ci.unfurls.author_name),
         author_url = COALESCE(EXCLUDED.author_url, ci.unfurls.author_url),
         site_name = COALESCE(EXCLUDED.site_name, ci.unfurls.site_name),
         description = COALESCE(EXCLUDED.description, ci.unfurls.description),
         canonical_url = COALESCE(EXCLUDED.canonical_url, ci.unfurls.canonical_url),
         thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, ci.unfurls.thumbnail_url),
         duration_seconds = COALESCE(EXCLUDED.duration_seconds, ci.unfurls.duration_seconds),
         external_ref = COALESCE(EXCLUDED.external_ref, ci.unfurls.external_ref),
         payload = EXCLUDED.payload,
         failure_count = EXCLUDED.failure_count,
         fetched_at = EXCLUDED.fetched_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()
       RETURNING id, user_id AS "userId", resolve_key AS "resolveKey", resolver, status, title,
         author_name AS "authorName", author_url AS "authorUrl", site_name AS "siteName", description,
         canonical_url AS "canonicalUrl", thumbnail_url AS "thumbnailUrl", poster_file_id AS "posterFileId",
         duration_seconds AS "durationSeconds", external_ref AS "externalRef", payload,
         failure_count AS "failureCount", fetched_at AS "fetchedAt", expires_at AS "expiresAt",
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        ctx.userId,
        target.key,
        target.resolver,
        outcome.status,
        data.title ?? null,
        data.authorName ?? null,
        data.authorUrl ?? null,
        data.siteName ?? null,
        data.description ?? null,
        data.canonicalUrl ?? null,
        data.thumbnailUrl ?? null,
        data.durationSeconds ?? null,
        data.externalRef ?? null,
        JSON.stringify(payload),
        failureCount,
        ttl,
      ],
    );

    return rows[0];
  }

  /** Copies the remote thumbnail into object storage; null when it cannot be had. */
  private async cachePoster(ctx: UserServiceContext, row: UnfurlEntity): Promise<string | null> {
    if (!row.thumbnailUrl) {
      return null;
    }

    const res = await this.fetcher.get(row.thumbnailUrl, { accept: 'image/*', maxBytes: MAX_IMAGE_BYTES });
    if (res.kind !== 'ok' || !res.contentType.startsWith('image/') || res.body.length === 0) {
      return null;
    }

    const contentType = res.contentType.split(';')[0].trim();
    const ext =
      contentType === 'image/png'
        ? 'png'
        : contentType === 'image/webp'
          ? 'webp'
          : contentType === 'image/gif'
            ? 'gif'
            : 'jpg';
    const digest = crypto.createHash('sha1').update(row.resolveKey).digest('hex').slice(0, 16);

    try {
      // NO externalId: to FileService that means "the bytes live elsewhere" and
      // it skips the upload entirely (the first cut of this passed one for
      // dedup and minted 1,508 rows with no object behind them). Content-hash
      // dedup inside `create` already collapses an unchanged poster.
      const file = await this.fileService.create(ctx, {
        buffer: res.body,
        contentType,
        size: res.body.length,
        filename: `unfurl-${digest}.${ext}`,
        title: row.title ?? undefined,
        variant: FileVariant.THUMBNAIL,
      });

      return file.id;
    } catch (e) {
      this.logger.warn('Poster cache failed', { key: row.resolveKey, error: (e as Error).message });

      return null;
    }
  }
}

/**
 * Whether a resolved thumbnail is worth a copy in object storage.
 *
 * The copy exists for links that rot: an OpenGraph `og:image` on someone's
 * signed CDN, a Wikimedia Commons file that gets renamed. Spotify cover art is
 * neither — `i.scdn.co/image/<hash>` is content-addressed, unsigned and stable
 * for years — and a personal corpus has tens of thousands of plays, so the
 * tile hotlinks it and the store keeps only what would otherwise go blank.
 * (YouTube never reaches here: its poster is templated from the id in
 * `derivePlayer` and it is not an oEmbed target at all.)
 */
export function shouldCachePoster(target: ResolveTarget): boolean {
  if (!config.unfurl.cachePosters) {
    return false;
  }

  return !(target.resolver === 'oembed' && target.providerRef?.startsWith('spotify:'));
}
