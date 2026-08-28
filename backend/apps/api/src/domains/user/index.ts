/**
 * This module manages all aspects of user accounts, including creation, profile management,
 * and the signup process. It provides the necessary services and controllers to handle
 * user data and authentication-related user tasks.
 *
 * ### Key Components:
 * - **`UserService` & `UserEntity`**: Core components for managing user data and business logic.
 * - **`SignupCodeService` & `SignupCodeEntity`**: Handle the logic for user invitation and signup codes.
 *
 * ### Module Integration:
 * - **`EventsModule`**: Publishes events, such as when a new user is created, to allow other
 *   parts of the system to react.
 * - **`FilesModule`**: Supplies the object store to the account purge, which has to delete
 *   the uploaded bytes as well as the rows that point at them.
 *
 * @module UserModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { FilesModule, FileService } from '@ci/domains/files';

import { AccountPurgeCron } from './cron/AccountPurgeCron';
import { UserEntity } from './entities/UserEntity';
import { PURGE_OBJECT_STORE, type PurgeObjectStore } from './purge/objectStore';
import { AccountPurgeService } from './services/AccountPurgeService';
import { UserService } from './services/UserService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), EventsModule, FilesModule],
  providers: [
    UserService,
    AccountPurgeService,
    AccountPurgeCron,
    {
      // Narrow the file service down to the two-method interface the purge
      // needs, so the purge cannot reach the rest of the files domain and the
      // dependency stays legible from this file.
      provide: PURGE_OBJECT_STORE,
      inject: [FileService],
      useFactory: (fileService: FileService): PurgeObjectStore => ({
        deleteObjects: (bucket, keys) => fileService.deleteObjects(bucket, keys),
      }),
    },
  ],
  exports: [UserService, AccountPurgeService],
})
export class UserModule {}

// Entities
export { UserEntity };

// Services
export { UserService, AccountPurgeService };

// Account purge
export { PURGE_OBJECT_STORE, type PurgeObjectStore } from './purge/objectStore';
export { buildPurgePlan } from './purge/purgePlan';
export type { PurgePlan, PurgeStep } from './purge/types';

// Types
export type { User, OnboardingProgress, UserRole } from './entities/UserEntity';
export type { CreateUserDto, UpdateUserDto } from './types';
export { UserCreatedEvent, type UserCreatedPayload } from './events';
