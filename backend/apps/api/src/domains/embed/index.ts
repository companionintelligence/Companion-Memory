import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FilesModule } from '@ci/domains/files';

import { UnfurlEntity } from './entities/UnfurlEntity';
import { UnfurlFetcher } from './services/UnfurlFetcher';
import { UnfurlService } from './services/UnfurlService';

/**
 * Rich media for content rows.
 *
 *  - `derivePlayer` — tier 0: a provider player from a URL, no network, no table.
 *  - `UnfurlService` — tier 1: resolved link previews (`ci.unfurls`) via oEmbed,
 *    Wikidata/Wikipedia and OpenGraph, fetched only by the `enrich.unfurl` pipeline stage and
 *    only through `UnfurlFetcher`, the SSRF chokepoint.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UnfurlEntity]), FilesModule],
  providers: [UnfurlFetcher, UnfurlService],
  exports: [UnfurlService],
})
export class EmbedModule {}

export { derivePlayer, derivePlayerFromRef } from './derivePlayer';
export type { StructuralPlayer } from './derivePlayer';
export { resolveTargetFor, OEMBED_PROVIDERS } from './resolveKey';
export type { ResolveSource, ResolveTarget, Resolver } from './resolveKey';
export { parseStreamingTitle, normalizeWorkTitle } from './streamingTitle';
export type { StreamingWork } from './streamingTitle';
export { UnfurlEntity } from './entities/UnfurlEntity';
export { UnfurlService } from './services/UnfurlService';
export type { ResolveResult } from './services/UnfurlService';
export type { UnfurlStatus } from './resolvers/types';
