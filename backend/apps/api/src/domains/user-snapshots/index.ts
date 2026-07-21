import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserSnapshotEntity } from './entities/UserSnapshotEntity';
import { UserSnapshotService } from './services/UserSnapshotService';

@Module({
  imports: [TypeOrmModule.forFeature([UserSnapshotEntity])],
  providers: [UserSnapshotService],
  exports: [UserSnapshotService],
})
export class UserSnapshotsModule {}

export { UserSnapshotEntity };
export { UserSnapshotService };
export type { CreateUserSnapshotDto } from './services/UserSnapshotService';
