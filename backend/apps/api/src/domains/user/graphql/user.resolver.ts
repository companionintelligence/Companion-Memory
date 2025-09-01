import { Resolver, Query, Mutation, Args, Context } from '@nestjs/graphql';
import { UseGuards, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { PgErrorCode } from '@ci/common/constants';

import { UserGraphQLService } from '../services/UserGraphQLService';
import { User } from './user.type';
import { CreateUserInput, UpdateUserInput } from './user.input';

@Resolver(() => User)
export class UserResolver {
  constructor(private readonly userGraphQLService: UserGraphQLService) {}

  @UseGuards(JwtAuthGuard)
  @Query(() => User, { name: 'me' })
  async getCurrentUser(@Context('req') req: any): Promise<User> {
    const context: RequestContext = req?.context;
    const userId = context?.userId;

    if (!userId) {
      throw new NotFoundException('User not found');
    }

    const userEntity = await this.userGraphQLService.findOne(userId);
    if (!userEntity) {
      throw new NotFoundException('User not found');
    }

    return {
      id: userEntity.id,
      name: userEntity.name,
      email: userEntity.email,
      createdAt: userEntity.createdAt,
      updatedAt: userEntity.updatedAt,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => [User])
  async users(): Promise<User[]> {
    const userEntities = await this.userGraphQLService.findAll();
    return userEntities.map(entity => ({
      id: entity.id,
      name: entity.name,
      email: entity.email,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    }));
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => User)
  async user(@Args('id') id: string): Promise<User> {
    const userEntity = await this.userGraphQLService.findOne(id);
    if (!userEntity) {
      throw new NotFoundException('User not found');
    }

    return {
      id: userEntity.id,
      name: userEntity.name,
      email: userEntity.email,
      createdAt: userEntity.createdAt,
      updatedAt: userEntity.updatedAt,
    };
  }

  @Mutation(() => User)
  async createUser(@Args('input') input: CreateUserInput): Promise<User> {
    try {
      const userEntity = await this.userGraphQLService.create(input);
      return {
        id: userEntity.id,
        name: userEntity.name,
        email: userEntity.email,
        createdAt: userEntity.createdAt,
        updatedAt: userEntity.updatedAt,
      };
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw new Error('User with this email already exists');
      }
      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => User)
  async updateUser(
    @Args('id') id: string,
    @Args('input') input: UpdateUserInput,
  ): Promise<User> {
    try {
      const userEntity = await this.userGraphQLService.update(id, input);
      if (!userEntity) {
        throw new NotFoundException('User not found');
      }
      return {
        id: userEntity.id,
        name: userEntity.name,
        email: userEntity.email,
        createdAt: userEntity.createdAt,
        updatedAt: userEntity.updatedAt,
      };
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw new Error('User with this email already exists');
      }
      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => Boolean)
  async deleteUser(@Args('id') id: string): Promise<boolean> {
    await this.userGraphQLService.remove(id);
    return true;
  }
}