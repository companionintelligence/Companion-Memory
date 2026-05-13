import path from 'path';

import { Test } from '@nestjs/testing';
import { MultiBar, Presets } from 'cli-progress';

import { LoggerService } from '@ci/common/logging';
import { EtlModule } from '@ci/domains/etl';
import { EventService, LocalEventService } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';
import { GraphQLModule } from '@ci/domains/graphql';
import { LLMModule } from '@ci/domains/llm';
import { McpModule } from '@ci/domains/mcp';
import { ToolsModule } from '@ci/domains/tools';

import { App } from '../../src/application';

import * as actionsData from './data/actions';
import * as communicationsData from './data/communications';
import * as conceptsData from './data/concepts';
import * as contentData from './data/content';
import * as eventsData from './data/events';
import * as hbpeData from './data/hbpe';
import * as itemsData from './data/items';
import * as messagesData from './data/messages';
import * as notesData from './data/notes';
import * as placesData from './data/places';
import * as summariesData from './data/summaries';
import * as threadsData from './data/threads';
import * as usersData from './data/users';
import { findMaxDate, shiftDatesInObject } from './date-shifter';
import { seedActions } from './seed-actions';
import { seedAnswers } from './seed-answers';
import { seedCommunications } from './seed-communications';
import { seedConcepts } from './seed-concepts';
import { seedEvents } from './seed-events';
import { seedHbpe } from './seed-hbpe';
import { seedItems } from './seed-items';
import { seedMessages } from './seed-messages';
import { seedNotes } from './seed-notes';
import { seedPeople } from './seed-people';
import { seedPlaces } from './seed-places';
import { seedRelationships } from './seed-relationships';
import { seedSummaries } from './seed-summaries';
import { seedThreads } from './seed-threads';
import { seedUsers } from './seed-users';

const logger = new LoggerService();

(async function () {
  const dataDir = path.resolve(__dirname, '..', 'seed-database');

  const createFilteredLogger = () => {
    const logger = new LoggerService();

    logger.error = () => {};

    logger.warn = () => {};

    logger.log = () => {};

    logger.debug = () => {};

    return logger;
  };

  const module = await Test.createTestingModule({
    imports: [App],
  })
    .overrideProvider(LoggerService)
    .useFactory({
      factory: createFilteredLogger,
    })
    .overrideProvider(EventService)
    .useClass(LocalEventService)
    .overrideProvider(FileService)
    .useValue({})
    .overrideModule(EtlModule)
    .useModule(class {})
    .overrideModule(GraphQLModule)
    .useModule(class {})
    .overrideModule(LLMModule)
    .useModule(class {})
    .overrideModule(McpModule)
    .useModule(class {})
    .overrideModule(ToolsModule)
    .useModule(class {})
    .compile();

  await module.init();

  let error: Error | null = null;

  const TASK_WIDTH = 15;
  const COUNT_WIDTH = 5;

  const multibar = new MultiBar(
    {
      format: (options, params, payload) => {
        const completeSize = Math.round(params.progress * options.barsize!);
        const incompleteSize = options.barsize! - completeSize;

        const bar =
          options.barCompleteChar!.repeat(completeSize) + options.barIncompleteChar!.repeat(incompleteSize);

        const pct = Math.round(params.progress * 100)
          .toString()
          .padStart(3);

        const val = params.value.toString().padStart(COUNT_WIDTH);
        const tot = params.total.toString().padEnd(COUNT_WIDTH);

        let rawTask = payload.task || '';

        if (rawTask.length > TASK_WIDTH) {
          rawTask = rawTask.substring(0, TASK_WIDTH - 1) + '…';
        }

        const task = rawTask.padStart(TASK_WIDTH);

        return `${task}  ${bar}  ${pct}%  ${val + '/' + tot}`;
      },

      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      barsize: 40,
      stopOnComplete: true,
      clearOnComplete: false,
    },
    Presets.shades_classic,
  );

  const allData = [
    actionsData,
    communicationsData,
    conceptsData,
    contentData,
    eventsData,
    hbpeData,
    itemsData,
    messagesData,
    notesData,
    placesData,
    summariesData,
    threadsData,
    usersData,
  ];

  const maxDate = findMaxDate(allData);
  if (maxDate) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const deltaMs = yesterday.getTime() - maxDate.getTime();
    logger.log(
      `Shifting seed data by ${Math.round(deltaMs / (24 * 60 * 60 * 1000))} days to align max date ${maxDate.toISOString()} with ${yesterday.toISOString()}`,
      'SeedDatabase',
    );
    shiftDatesInObject(allData, deltaMs);
  }

  try {
    await seedUsers(module, multibar);
    await seedPeople(module, multibar);
    await seedAnswers(module, multibar, path.resolve(dataDir, 'data', 'answers.csv'));
    await seedThreads(module, multibar);
    await seedActions(module, multibar);
    await seedMessages(module, multibar);
    await seedNotes(module, multibar);
    await seedItems(module, multibar);
    await seedPlaces(module, multibar);
    await seedConcepts(module, multibar);
    await seedEvents(module, multibar);
    // Our seed content is logically incosistent and overloads concepts of other
    // entity types (e.g. Photo and Video are actually now Files). Until we have
    // refactored the data, we will skip seeding content.
    // await seedContent(module, multibar);
    await seedCommunications(module, multibar);
    await seedRelationships(module, multibar);
    await seedSummaries(module, multibar);
    await seedHbpe(module, multibar);
  } catch (err) {
    error = err as Error;
  }

  if (error) {
    logger.error(error);
  }

  multibar.stop();

  await module.close();

  process.exit(error == null ? 0 : 1);
})();
