import path from 'path';

import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import config from '@ci/configuration';
import { AnswerEntity, QuestionEntity } from '@ci/domains/intelligence';
import { ContentEntity, EventEntity } from '@ci/domains/memory';
import { EmbeddingEntity, EmbeddingService, TagEntity } from '@ci/domains/search';
import { UserEntity } from '@ci/domains/user';

const logger = new Logger(path.basename(__filename));

(async function () {
  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    entities: [
      AnswerEntity,
      ContentEntity,
      EmbeddingEntity,
      EventEntity, // Unused, but relationally dependent
      QuestionEntity,
      TagEntity, // Unused, but relationally dependent
      UserEntity, // Unused, but relationally dependent
    ],
    synchronize: false,
    logging: ['error', 'schema'],
  });

  let error: Error | null;

  try {
    await db.initialize();

    const embeddingRepo = db.getRepository(EmbeddingEntity);
    const embeddingService = new EmbeddingService(embeddingRepo);

    await db.transaction(async (manager) => {
      const questions = await manager.find(QuestionEntity, {
        relations: ['user'],
      });

      logger.log(`Indexing ${questions.length} question records`);

      for (const [index, entity] of questions.entries()) {
        logger.log(`Generating vector embeddings for question, ${index + 1} / ${questions.length}`);

        await embeddingService.indexEntity(entity, 'text');
      }
    });

    await db.transaction(async (manager) => {
      const answers = await manager.find(AnswerEntity, {
        relations: ['user'],
      });

      logger.log(`Indexing ${answers.length} answer records`);

      for (const [index, entity] of answers.entries()) {
        logger.log(`Generating vector embeddings for answer, ${index + 1} / ${answers.length}`);

        await embeddingService.indexEntity(entity, 'give_answer_1');
      }
    });

    await db.transaction(async (manager) => {
      const content = await manager.find(ContentEntity, {
        relations: ['user'],
      });

      logger.log(`Indexing ${content.length} content records`);

      for (const [index, entity] of content.entries()) {
        logger.log(`Generating vector embeddings for content, ${index + 1} / ${content.length}`);

        if (entity.text == null) {
          continue;
        }

        await embeddingService.indexEntity(entity, 'text');
      }
    });

    process.exit(0);
  } catch (err) {
    error = err as Error;
  } finally {
    await db.destroy();
  }

  if (error) {
    logger.error(error);
  }

  process.exit(error == null ? 0 : 1);
})();
