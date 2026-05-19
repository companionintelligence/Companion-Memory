/**
 * Plan 10 — Actors module. An actor is the access unit (user, agent, device,
 * household). This module exposes the entity, service, and ActorsModule for
 * cross-domain injection. Wiring of actor_id into RequestContext and into
 * domain reads/writes happens in follow-up commits.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActorEntity } from './entities/ActorEntity';
import { ActorService } from './services/ActorService';

@Module({
  imports: [TypeOrmModule.forFeature([ActorEntity])],
  providers: [ActorService],
  exports: [ActorService],
})
export class ActorsModule {}

export { ActorService } from './services/ActorService';
export { ActorEntity, type Actor, type ActorKind } from './entities/ActorEntity';
