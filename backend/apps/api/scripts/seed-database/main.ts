import path from 'path';

import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import config from '@ci/configuration';
import { ConnectionEntity, ProviderEntity } from '@ci/domains/connections';
import { MessageEntity, ThreadEntity } from '@ci/domains/conversations';
import { ActionEntity, AnswerEntity, QuestionEntity } from '@ci/domains/intelligence';
import {
  ContactEntity,
  ContentEntity,
  EventEntity,
  LocationEntity,
  PersonEntity,
  PlaceEntity,
  ThingEntity,
} from '@ci/domains/memory';
import { TagEntity } from '@ci/domains/search';
import { UserEntity } from '@ci/domains/user';

import { seedActions } from './seed-actions';
import { seedAnswers } from './seed-answers';
import { seedContacts } from './seed-contacts';
import { seedContent } from './seed-content';
import { seedEvents } from './seed-events';
import { seedLocations } from './seed-locations';
import { seedMessages } from './seed-messages';
import { seedPeople } from './seed-people';
import { seedPlaces } from './seed-places';
import { seedProviders } from './seed-providers';
import { seedQuestions } from './seed-questions';
import { seedThings } from './seed-things';
import { seedThreads } from './seed-threads';
import { seedUsers } from './seed-users';

const logger = new Logger(path.basename(__filename));

(async function () {
  const dataDir = path.resolve(__dirname);

  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    entities: [
      // Conversation
      MessageEntity,
      ThreadEntity,
      // Memory
      ContactEntity,
      ContentEntity,
      EventEntity,
      LocationEntity,
      PersonEntity,
      PlaceEntity,
      ThingEntity,
      // Intelligence
      ActionEntity,
      AnswerEntity,
      QuestionEntity,
      // Providers
      ConnectionEntity,
      ProviderEntity,
      // Search,
      TagEntity,
      // Users
      UserEntity,
    ],
    synchronize: false,
    logging: ['error'],
  });

  let error: Error | null;

  try {
    await db.initialize();

    // Providers Data
    await seedProviders(db, path.resolve(dataDir, './providers-data/providers.csv'));

    // Intelligence Data
    await seedQuestions(db, path.resolve(dataDir, './intelligence-data/questions.csv'));

    // John Smith
    await seedUsers(db, path.resolve(dataDir, './js1-data/js1-users.csv'));
    await seedEvents(db, path.resolve(dataDir, './js1-data/js1-events.csv'));
    await seedPeople(db, path.resolve(dataDir, './js1-data/js1-people.csv'));
    await seedContacts(db, path.resolve(dataDir, './js1-data/js1-contacts.csv'));
    await seedContent(db, path.resolve(dataDir, './js1-data/js1-content.csv'));
    await seedThings(db, path.resolve(dataDir, './js1-data/js1-things.csv'));
    await seedPlaces(db, path.resolve(dataDir, './js1-data/js1-places.csv'));
    await seedLocations(db, path.resolve(dataDir, './js1-data/js1-locations.csv'));
    await seedAnswers(db, path.resolve(dataDir, './js1-data/js1-answers.csv'));
    await seedThreads(db, path.resolve(dataDir, './js1-data/js1-threads.csv'));
    await seedActions(db, path.resolve(dataDir, './js1-data/js1-actions.csv'));
    await seedMessages(db, path.resolve(dataDir, './js1-data/js1-messages.csv'));

    process.exit(0);
  } catch (err) {
    error = err as Error;
  }

  if (error) {
    logger.error(error);
  }

  if (db.isInitialized) {
    await db.destroy();
  }

  process.exit(error == null ? 0 : 1);
})();
