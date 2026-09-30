import { input, password as passwordInput } from '@inquirer/prompts';
import bcrypt from 'bcrypt';
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
    const password = await passwordInput({
      message: 'New password:',
      mask: '·',
      validate: (value) => value.length >= 8 || 'Must be at least 8 characters',
    });

    user.password = await bcrypt.hash(password, config.auth.local.saltRounds);
    // Somebody knows this password now, so AccountController.requireReauth must ask
    // for it. Left null — as it is on a Hub- or Portal-provisioned account this is
    // often run to rescue — the account would keep proving itself by a recent
    // sign-in alone.
    user.passwordSetAt = new Date();

    try {
      await db.transaction(async (manager) => {
        await manager.save(user);
      });

      console.log(`\nPassword successfully updated: ${user.id}`);
    } catch (err) {
      console.error('\nFailed to update user', (err as Error).message);
      exitCode = 1;
    }
  }

  await db.destroy();

  process.exit(exitCode);
})();
