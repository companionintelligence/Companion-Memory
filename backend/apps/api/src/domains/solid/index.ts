/**
 * Solid Protocol facade (Path B: an adapter over the existing store).
 *
 * This module projects CI-Server's existing data as a Solid-compatible surface
 * without changing the Postgres source of truth. It is intentionally
 * self-contained — it only *reads* other domains (currently `UserService`) — so
 * it can grow the Solid pillars (WebID → Solid-OIDC → LDP resources → RDF
 * projection → WAC) with minimal blast radius on the rest of the API.
 *
 * The entire surface is gated behind the `solid.protocol` feature flag (off by
 * default), so merging incremental slices to main is safe.
 *
 * Slice 1: WebID Profile Documents at `GET /solid/profile/:userId` (public).
 * Slice 2: RDF projection of a `ci.entities` row at
 *   `GET /solid/storage/:userId/entity/:entityId` (authenticated, owner-only).
 * Slice 3: the entity container (LDP BasicContainer) at
 *   `GET /solid/storage/:userId/entity/` — makes the pod browsable.
 * All are Turtle/JSON-LD content-negotiated.
 *
 * @module SolidModule
 */

import { Module } from '@nestjs/common';

import { MemoryModule } from '@ci/domains/memory';
import { UserModule } from '@ci/domains/user';

import { StorageController } from './controllers/StorageController';
import { WebIdController } from './controllers/WebIdController';
import { ContainerService } from './services/ContainerService';
import { EntityProjectionService } from './services/EntityProjectionService';
import { ProfileDocumentService } from './services/ProfileDocumentService';
import { WebIdService } from './services/WebIdService';

/**
 * @internal
 */
@Module({
  imports: [UserModule, MemoryModule],
  controllers: [WebIdController, StorageController],
  providers: [WebIdService, ProfileDocumentService, EntityProjectionService, ContainerService],
  exports: [WebIdService, ProfileDocumentService, EntityProjectionService, ContainerService],
})
export class SolidModule {}

export { WebIdService } from './services/WebIdService';
export { ProfileDocumentService } from './services/ProfileDocumentService';
export { EntityProjectionService } from './services/EntityProjectionService';
export { ContainerService } from './services/ContainerService';
