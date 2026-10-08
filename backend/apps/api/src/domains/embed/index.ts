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
export { watchLinkFor } from './watchLinks';
export type { WatchLinks } from './watchLinks';
export { UnfurlEntity } from './entities/UnfurlEntity';
export { UnfurlService } from './services/UnfurlService';
// The SSRF chokepoint's address rules, for the other places the appliance downloads a URL that
// came out of synced data (Facebook media). One set of rules, so a range blocked here is blocked
// there too.
export { BlockedAddressError, guardedLookup, isBlockedHostname, readCapped } from './services/UnfurlFetcher';
export type { ResolveResult } from './services/UnfurlService';
export type { UnfurlStatus } from './resolvers/types';
