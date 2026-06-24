import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { EventService } from '@ci/domains/events';
import { UserEntity, UserService } from '@ci/domains/user';

import { JOHN_SMITH } from './seed-database/data/users';

/**
 * `yarn bootstrap-user` — create the default account on a fresh install.
 *
 * The marketplace ci-memory deployment runs this once, after `migrate-database`,
 * to seed the initial user from AUTH_DEFAULT_USER_EMAIL / AUTH_DEFAULT_USER_PASSWORD
 * (see ./seed-database/data/users.ts). It is the lightweight, production
 * equivalent of the `seedUsers` step in the demo seeder (scripts/seed-database/main.ts):
 * same idempotent findById → create → onboard, without the rest of the demo data.
 *
 * We boot a minimal Nest context — only the DB connection and what UserService
 * needs — rather than the full App, because at install time the orchestrator,
 * object-store and LLM services aren't up yet, and only the database has been
 * migrated. EventService is stubbed to a no-op: the real (PgBoss) implementation
 * needs a started queue we don't have here, and nothing consumes the
 * UserCreated event during the initial bootstrap.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: config.db.type,
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      username: config.db.username,
      password: config.db.password,
      entities: [UserEntity],
      synchronize: false,
    }),
    TypeOrmModule.forFeature([UserEntity]),
  ],
  providers: [
    UserService,
    {
      provide: EventService,
      useValue: { send: async () => [] as string[] } as unknown as EventService,
    },
  ],
})
class BootstrapUserModule {}

async function main(): Promise<void> {
  const { id, name, email, password } = JOHN_SMITH;

  // Capture into a local so the non-null narrowing survives the awaits below.
  if (password == null || password === '') {
    throw new Error('AUTH_DEFAULT_USER_PASSWORD is not set — cannot bootstrap the default user.');
  }

  const logger = new LoggerService();
  logger.setContext('bootstrap-user');

  const app = await NestFactory.createApplicationContext(BootstrapUserModule, {
    logger: false,
  });

  try {
    const userService = app.get(UserService);

    const existing = await userService.findById({ userId: SYSTEM_USER }, id);

    if (existing != null) {
      logger.log(`Default user already exists (${email}); nothing to do.`);

      return;
    }

    await userService.create({ userId: SYSTEM_USER }, { id, name, email, password });

    await userService.onboard(id);

    logger.log(`Bootstrapped default user ${email}.`);
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('bootstrap-user failed:', err);

    process.exit(1);
  });
