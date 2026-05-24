import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type SignupCode, SignupCodeEntity } from '../entities/SignupCodeEntity';
import { UpdateSignupCodeDto } from '../types';

@Injectable()
export class SignupCodeService {
  constructor(
    @InjectRepository(SignupCodeEntity)
    private readonly signupCodeRepository: Repository<SignupCodeEntity>,
  ) {}

  async create(): Promise<SignupCode> {
    const signupCode = this.signupCodeRepository.create({
      signup_code: crypto.randomBytes(6).toString('hex'),
    });

    return await this.signupCodeRepository.save(signupCode);
  }

  async findOne(signup_code: string): Promise<SignupCode | null> {
    const result = await this.signupCodeRepository.findOne({
      where: {
        signup_code,
        used: false,
      },
    });

    return result ?? null;
  }

  async update(signup_code: string, data: UpdateSignupCodeDto): Promise<null> {
    const code = await this.findOne(signup_code);

    if (!code) {
      return null;
    }

    await this.signupCodeRepository.update(code.id, data);

    return null;
  }
}
