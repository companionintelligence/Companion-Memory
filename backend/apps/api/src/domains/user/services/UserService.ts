import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcrypt';
import { DeleteResult, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import config from '@ci/configuration';
import { GraphUtilityService } from '@ci/domains/memory';

import { UserEntity } from '../entities/UserEntity';
import { CreateUserDto, UpdateUserDto, User } from '../types';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly graphUtilityService: GraphUtilityService,
  ) {}

  async create(data: CreateUserDto): Promise<User> {
    const hashedPassword = await bcrypt.hash(data.password, config.auth.local.saltRounds);
    const nameForEntity = data.name ?? data.email;

    const user = this.userRepository.create({
      ...data,
      id: uuidv7(),
      password: hashedPassword,
    });

    const savedUser = await this.userRepository.save(user);

    const entityId = uuidv7();
    const nameParts = (data.name ?? '').trim().split(/\s+/).filter(Boolean);
    const [firstName, ...restName] = nameParts;

    const properties: Record<string, unknown> = {
      email: data.email,
    };
    if (firstName) {
      properties.first_name = firstName;
    }

    if (restName.length > 0) {
      properties.last_name = restName.join(' ');
    }

    await this.graphUtilityService.createOrUpdateNode(savedUser.id, {
      entityId,
      entityType: 'Person',
      name: nameForEntity,
      description: nameForEntity,
      properties,
      searchContent: nameForEntity,
      linkedTable: 'users',
      linkedId: savedUser.id,
    });

    await this.userRepository.update(savedUser.id, { entityId });
    savedUser.entityId = entityId;

    return savedUser.toUser();
  }

  async findAll(): Promise<User[]> {
    const result = await this.userRepository.find();

    return result.map((entity) => entity.toUser());
  }

  async findOne(id: string): Promise<User | null> {
    const result = await this.userRepository.findOne({
      where: {
        id,
      },
    });

    return result?.toUser() ?? null;
  }

  async update(id: string, data: UpdateUserDto): Promise<User | null> {
    await this.userRepository.update(id, data);

    return this.findOne(id);
  }

  remove(id: string): Promise<DeleteResult> {
    return this.userRepository.delete(id);
  }

  async validatePassword(email: string, password: string): Promise<User | null> {
    const result = await this.userRepository.findOne({
      where: {
        email,
      },
    });

    if (result == null) {
      return null;
    }

    const validCredentials = await bcrypt.compare(password, result.password);

    if (!validCredentials) {
      return null;
    }

    return result.toUser();
  }

  async checkEmailAvailability(email: string): Promise<boolean> {
    const result = await this.userRepository.findOne({
      where: {
        email,
      },
    });

    return !!result;
  }

  async onboard(id: string): Promise<void> {
    await this.userRepository.update(id, {
      onboarded: true,
    });
  }
}
