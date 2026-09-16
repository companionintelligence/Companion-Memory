import path from 'path';

import { MultiBar, Presets } from 'cli-progress';

import { LoggerService } from '@ci/common/logging';
import { verifyDatabaseSchema } from '@ci/common/persistence';
import config from '@ci/configuration';
import { FileService } from '@ci/domains/files';
import { PythonFunctionCrons } from '@ci/domains/python-functions/cron/PythonFunctionCrons';

import { createAdminTestingModule } from '../support/admin-testing-module';

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
import * as tasksData from './data/tasks';
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
import { seedSavedSearches } from './seed-saved-searches';
import { seedSummaries } from './seed-summaries';
import { seedTasks } from './seed-tasks';
import { seedThreads } from './seed-threads';
import { seedUsers } from './seed-users';

const logger = new LoggerService();

(async function () {
  // Same guard the api runs at boot. Seeding writes across a dozen tables, so a
  // schema that is not this checkout's fails partway — half the demo dataset
  // in, the rest lost to `relation "ci.x" does not exist`.
  try {
    await verifyDatabaseSchema(config.db);
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const dataDir = path.resolve(__dirname, '..', 'seed-database');

  const module = await createAdminTestingModule()
    // Seed data references files by id without uploading any bytes, so nothing
    // here needs object storage. ActivityRollupCron.onApplicationBootstrap still
    // fires a refresh on module.init() below, and ActivityRollupService injects
    // this same FileService for aggregateHourlyActivity() — the one FileService
    // method any onApplicationBootstrap/onModuleInit hook in the seed's module
    // graph calls — so the stub has to answer it too, or that refresh throws
    // (non-fatally, but every seed run logs an ERROR and skips the 'files'
    // activity rollup source).
    .overrideProvider(FileService)
    .useValue({ aggregateHourlyActivity: async () => [] })
    // Same class of problem, different hook. PythonFunctionCrons'
    // onApplicationBootstrap arms a 30-SECOND setTimeout that fans out an
    // `ensure_bootstrap` job per onboarded user, and the dispatch listener
    // POSTs each one to services.hbpe.host — a sidecar no admin script runs.
    //
    // The cron guards its own promise, but under LocalEventService the
    // listener executes INLINE and @nestjs/event-emitter floats that promise,
    // so the `fetch failed` surfaces as an unhandled rejection and kills the
    // script. Not a hypothetical: it is timing-dependent, and it only started
    // firing once the seed got slow enough to still be running at T+30s —
    // which is to say, once CI grew a real Ollama and the seed began
    // generating embeddings instead of dying on the first person.
    //
    // Overriding the provider (rather than stubbing the module) is deliberate:
    // PythonFunctionCrons is a leaf — nothing injects it and
    // PythonFunctionsModule does not export it — so this removes the bootstrap
    // hook without touching a token anything else resolves. See this file's
    // FileService note above and the "Why a stub is not `class {}`" section in
    // scripts/support/admin-testing-module.ts for why that distinction matters.
    .overrideProvider(PythonFunctionCrons)
    .useValue({})
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
    // Tasks move with the corpus but are deliberately absent from `allData`
    // above: `findMaxDate` pins the newest date in the set to yesterday, so a
    // task dated after the last seeded event would drag the whole corpus back a
    // day AND still land in the past. Excluded from the max, dates past the
    // anchor stay ahead of the seeding moment — which is where a plan lives.
    shiftDatesInObject(tasksData, deltaMs);
  }

  try {
    await seedUsers(module, multibar);
    await seedSavedSearches(module, multibar);
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
    // After events: a scheduled task is placed as a `planned_block` event, so
    // this writes into the same ci.events table the seeder has just filled.
    await seedTasks(module, multibar);
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
