import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { UnfurlService } from '@ci/domains/embed';
import { FileService } from '@ci/domains/files';

import { Loader } from './Loader';

/** A resolved link preview, as the UI consumes it. */
export interface UnfurlView {
  status: string;
  resolver: string;
  title: string | null;
  authorName: string | null;
  authorUrl: string | null;
  siteName: string | null;
  description: string | null;
  canonicalUrl: string | null;
  /** Local poster copy (signed object-store path) when cached; else the provider's URL. */
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  externalRef: string | null;
  payload: Record<string, unknown>;
  fetchedAt: Date;
}

/**
 * Batch-resolves resolve keys -> `ci.unfurls` rows (plus the signed URL of a
 * cached poster) for GraphQL. Keyed by resolve key, not content id, so N plays
 * of one track are one lookup — the same collapse the stage relies on.
 *
 * Read-only: a miss is `null`, never a fetch. The `enrich.unfurl` stage is the
 * only thing that talks to a provider.
 */
@Injectable()
export class UnfurlLoader extends Loader<UnfurlView | null, string> {
  constructor(
    private readonly unfurlService: UnfurlService,
    private readonly fileService: FileService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(UnfurlLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    keys: readonly string[],
  ): Promise<readonly (UnfurlView | null)[]> {
    const rows = await this.unfurlService.findByKeys(context, [...keys]);

    const posterIds = [
      ...new Set([...rows.values()].map((r) => r.posterFileId).filter((id): id is string => !!id)),
    ];
    const posters = posterIds.length ? await this.fileService.findByIds(context, posterIds) : [];
    const posterUrlById = new Map(
      posters.filter((file) => file != null).map((file) => [file.id, file.url ?? null]),
    );

    return keys.map((key) => {
      const row = rows.get(key);
      if (!row) {
        return null;
      }

      const local = row.posterFileId ? (posterUrlById.get(row.posterFileId) ?? null) : null;

      return {
        status: row.status,
        resolver: row.resolver,
        title: row.title,
        authorName: row.authorName,
        authorUrl: row.authorUrl,
        siteName: row.siteName,
        description: row.description,
        canonicalUrl: row.canonicalUrl,
        thumbnailUrl: local ?? row.thumbnailUrl,
        durationSeconds: row.durationSeconds,
        externalRef: row.externalRef,
        payload: row.payload ?? {},
        fetchedAt: row.fetchedAt,
      };
    });
  }
}
