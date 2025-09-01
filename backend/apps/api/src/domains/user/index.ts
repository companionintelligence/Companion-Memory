import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserController } from './controllers/UserController';
import { UserEntity } from './entities/UserEntity';
import { UserService } from './services/UserService';
import { UserGraphQLService } from './services/UserGraphQLService';
import { UserResolver } from './graphql/user.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  providers: [UserService, UserGraphQLService, UserResolver],
  controllers: [UserController],
  exports: [UserService],
})
export class UserModule {}

// Entities
export { UserEntity };

// Services
export { UserService };

// Types
export type { CreateUserDto, UpdateUserDto, User } from './types';
