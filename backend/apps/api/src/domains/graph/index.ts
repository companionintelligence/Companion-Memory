/**
 * @module GraphModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { MemoryModule } from '@ci/domains/memory';
import { UserModule } from '@ci/domains/user';

import { type Node, NodeEntity } from './entities/NodeEntity';
import { RelationshipEntity } from './entities/RelationshipEntity';
import { UserGraphListener } from './listeners/UserGraphListener';
import { GraphService } from './services/GraphService';
import { NodeService } from './services/NodeService';
import { RelationshipService } from './services/RelationshipService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([NodeEntity, RelationshipEntity]),
    EventsModule,
    MemoryModule,
    UserModule,
  ],
  providers: [GraphService, NodeService, RelationshipService, UserGraphListener],
  exports: [GraphService, NodeService, RelationshipService],
})
export class GraphModule {}

export { GraphService, NodeService, RelationshipService };
export type { Node };
export { RelationshipType } from './types';
