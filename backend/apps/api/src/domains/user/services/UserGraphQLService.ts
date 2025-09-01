import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import config from '@ci/configuration';

import { UserEntity } from '../entities/UserEntity';
import { CreateUserDto, UpdateUserDto } from '../types';

@Injectable()
export class UserGraphQLService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async create(data: CreateUserDto): Promise<UserEntity> {
    const hashedPassword = await bcrypt.hash(data.password, config.auth.local.saltRounds);

    const user = this.userRepository.create({
      ...data,
      id: uuidv7(),
      password: hashedPassword,
    });

    return this.userRepository.save(user);
  }

  async findAll(): Promise<UserEntity[]> {
    return this.userRepository.find();
  }

  async findOne(id: string): Promise<UserEntity | null> {
    return this.userRepository.findOne({
      where: {
        id,
      },
    });
  }

  async update(id: string, data: UpdateUserDto): Promise<UserEntity | null> {
    await this.userRepository.update(id, data);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.userRepository.delete(id);
  }
}