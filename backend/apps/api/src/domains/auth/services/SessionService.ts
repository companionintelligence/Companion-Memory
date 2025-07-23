import { createHmac } from 'crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcrypt';
import parseDuration from 'parse-duration';
import { MoreThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import config from '@ci/configuration';

import { SessionEntity } from '../entities/SessionEntity';
import { CreateSessionDto, RotateSessionDto } from '../types';

const SESSION_EXPIRES_IN = parseDuration(config.auth.session.duration) ?? 0;

@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepository: Repository<SessionEntity>,
  ) {}

  async create(userId: string, data: CreateSessionDto): Promise<void> {
    const hashedToken = await bcrypt.hash(data.token, config.auth.session.saltRounds);
    const hashedIp = this.digest(data.ip);
    const hashedUserAgent = this.digest(data.userAgent);

    const now = new Date().getTime();
    const expiresAt = new Date(now + SESSION_EXPIRES_IN);

    const session = this.sessionRepository.create({
      id: uuidv7(),
      token: hashedToken,
      ip: hashedIp,
      user_agent: hashedUserAgent,
      expires_at: expiresAt,
      user: {
        id: userId,
      },
    });

    await this.sessionRepository.save(session);
  }

  async rotate(userId: string, data: RotateSessionDto): Promise<void> {
    const hashedToken = await bcrypt.hash(data.token, config.auth.session.saltRounds);
    const hashedIp = this.digest(data.ip);
    const hashedUserAgent = this.digest(data.userAgent);

    const now = new Date();

    const existingSessions = await this.sessionRepository.find({
      where: {
        ip: hashedIp,
        user_agent: hashedUserAgent,
        expires_at: MoreThan(now),
        user: {
          id: userId,
        },
      },
    });

    const existingSession = existingSessions.find((session) => bcrypt.compareSync(data.token, session.token));

    if (!existingSession) {
      throw new UnauthorizedException('Invalid session');
    }

    existingSession.token = hashedToken;

    await this.sessionRepository.save(existingSession);
  }

  private digest(value?: string) {
    if (value == null) {
      return value;
    }

    return createHmac('sha256', config.auth.session.fieldPepper).update(value).digest('hex');
  }
}
