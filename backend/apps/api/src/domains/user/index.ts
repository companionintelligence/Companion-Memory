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
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { FilesModule, FileService } from '@ci/domains/files';

import { AccountPurgeCron } from './cron/AccountPurgeCron';
import { UserEntity } from './entities/UserEntity';
import { CLIENT_TIMEZONE_HEADER, ClientTimezoneInterceptor } from './interceptors/ClientTimezoneInterceptor';
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
      // Global from here rather than from `application.ts` because the thing it
      // maintains — `ci.users.timezone` — is this domain's column, and the
      // provider it needs is this module's. `APP_INTERCEPTOR` applies app-wide
      // whichever module declares it.
      provide: APP_INTERCEPTOR,
      useClass: ClientTimezoneInterceptor,
    },
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
  // PURGE_OBJECT_STORE also serves the immediate account delete (privacy domain),
  // which removes the same file objects.
  exports: [UserService, AccountPurgeService, PURGE_OBJECT_STORE],
})
export class UserModule {}

// Entities
export { UserEntity };

// Services
export { UserService, AccountPurgeService };

// The header clients send their IANA zone in; exported so a client-facing
// surface (CORS `allowedHeaders`, an HTTP client's default headers) names the
// same string this reads.
export { CLIENT_TIMEZONE_HEADER, ClientTimezoneInterceptor };

// Account purge
export { removeFromAskAudit, type AskAuditRemoval } from './purge/askAudit';
export {
  deleteSoleOwnedObjects,
  deleteStoredObjects,
  listSoleOwnedObjects,
  PURGE_OBJECT_STORE,
  type PurgeObjectStore,
  type StoredObject,
} from './purge/objectStore';
export { buildPurgePlan } from './purge/purgePlan';
export type { PurgePlan, PurgeStep } from './purge/types';

// Types
export type { User, OnboardingProgress, TimeFormat, UserRole } from './entities/UserEntity';
export { TIME_FORMATS } from './entities/UserEntity';
export type { CreateUserDto, UpdateUserDto } from './types';
export { normalizeEmail } from './email';
export {
  LastAdminDeletionRefused,
  SUCCESSOR_NOT_FOUND,
  SUCCESSOR_REQUIRED,
  type DeletionOptions,
} from './services/UserService';
export { UserCreatedEvent, type UserCreatedPayload } from './events';
