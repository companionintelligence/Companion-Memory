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
 *
 * @module UserModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { UserEntity, type User } from './entities/UserEntity';
import { UserService } from './services/UserService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), EventsModule],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}

// Entities
export { UserEntity };

// Services
export { UserService };

// Types
export type { User };
export type { CreateUserDto, UpdateUserDto } from './types';
export { UserCreatedEvent, type UserCreatedPayload } from './events';
