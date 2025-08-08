import { input } from '@inquirer/prompts';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';

import config from '@ci/configuration';
import { UserEntity } from '@ci/domains/user';

(async () => {
  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    entities: [UserEntity],
    synchronize: false,
    logging: ['error'],
  });

  await db.initialize();

  const email = await input({
    message: 'User email:',
    validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || 'Enter a valid email address',
  });

  const user = await db.getRepository(UserEntity).findOneBy({ email });

  let exitCode = 0;

  if (!user) {
    console.error(`\nNo user found with email: ${email}`);
    exitCode = 1;
  } else {
    const jwtService = new JwtService({
      secret: config.auth.jwt.authTokenSecret,
      signOptions: { expiresIn: '1d' },
    });

    const token = jwtService.sign({
      sub: user.id,
    });

    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    console.log(`\n${token}\n`);
    console.log(`Expires: ${in24h.toLocaleString()}`);
  }

  await db.destroy();

  process.exit(exitCode);
})();
