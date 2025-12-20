import crypto from 'crypto';

import { Injectable } from '@nestjs/common';
import { Ollama } from 'ollama';
import { DataSource } from 'typeorm';

import type { RequestContext } from '@ci/common/context';
import config from '@ci/configuration';

const EMBEDDING_MODEL = 'nomic-embed-text';

export interface SearchResult {
  text: string;
  type: string;
  id: string;
  distance: number;
  user_id?: string;
}

const ENTITY_CONFIG: Record<
  string,
  {
    table: string;
    idColumn: string;
    textColumn: string;
    embeddingColumn: string;
    userColumn?: string;
  }
> = {
  graph_node: {
    table: 'ci.entities',
    idColumn: 'entity_id',
    textColumn: 'search_content',
    embeddingColumn: 'embedding',
    userColumn: 'owner_user_id',
  },
  question: {
    table: 'ci.questions',
    idColumn: 'question_id',
    textColumn: 'question_text',
    embeddingColumn: 'question_embedding',
    userColumn: undefined,
  },
  answer: {
    table: 'ci.answers',
    idColumn: 'answer_id',
    textColumn: 'answer_text',
    embeddingColumn: 'answer_embedding',
    userColumn: 'user_id',
  },
  event: {
    table: 'ci.events',
    idColumn: 'event_id',
    textColumn: 'title',
    embeddingColumn: 'event_embedding',
    userColumn: 'user_id',
  },
  entity: {
    table: 'ci.entities',
    idColumn: 'entity_id',
    textColumn: 'name',
    embeddingColumn: 'embedding',
    userColumn: 'owner_user_id',
  },
};

@Injectable()
export class EmbeddingService {
  private readonly ollama = new Ollama({
    host: config.services.ollama.host,
  });

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Generate an embedding vector for a given text input
   */
  async generateEmbedding(input: string): Promise<number[]> {
    return this.calculateVector(input);
  }

  /**
   * Generate an embedding vector and format it as a PostgreSQL-compatible string
   */
  async generateEmbeddingString(input: string): Promise<string> {
    return this.calculateVectorString(input);
  }

  // ==================== ENTITY-SPECIFIC EMBEDDING METHODS ====================

  /**
   * Generate and store embedding for a question
   */
  async embedQuestion(questionId: string, questionText: string): Promise<boolean> {
    try {
      const embeddingString = await this.generateEmbeddingString(questionText);
      await this.dataSource.query(`UPDATE ci.questions SET question_embedding = $1 WHERE question_id = $2`, [
        embeddingString,
        questionId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed question ${questionId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embedding for an answer
   */
  async embedAnswer(answerId: string, answerText: string): Promise<boolean> {
    try {
      const embeddingString = await this.generateEmbeddingString(answerText);
      await this.dataSource.query(`UPDATE ci.answers SET answer_embedding = $1 WHERE answer_id = $2`, [
        embeddingString,
        answerId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed answer ${answerId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embedding for content
   */
  async embedContent(contentId: string, text: string): Promise<boolean> {
    try {
      const embeddingString = await this.generateEmbeddingString(text);
      await this.dataSource.query(`UPDATE ci.content SET embedding = $1 WHERE id = $2`, [
        embeddingString,
        contentId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed content ${contentId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embedding for an entity
   */
  async embedEntity(entityId: string, searchContent: string): Promise<boolean> {
    try {
      const embeddingString = await this.generateEmbeddingString(searchContent);
      await this.dataSource.query(`UPDATE ci.entities SET embedding = $1 WHERE entity_id = $2`, [
        embeddingString,
        entityId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed entity ${entityId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embedding for an event
   */
  async embedEvent(eventId: string, searchContent: string): Promise<boolean> {
    try {
      const embeddingString = await this.generateEmbeddingString(searchContent);
      await this.dataSource.query(`UPDATE ci.events SET event_embedding = $1 WHERE event_id = $2`, [
        embeddingString,
        eventId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed event ${eventId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embedding for an inventory item
   */
  async embedInventoryItem(
    objectId: string,
    objectName: string,
    objectDescription?: string,
  ): Promise<boolean> {
    try {
      const text = [objectName, objectDescription].filter(Boolean).join(' ');
      const embeddingString = await this.generateEmbeddingString(text);
      await this.dataSource.query(`UPDATE ci.inventory SET object_embedding = $1 WHERE object_id = $2`, [
        embeddingString,
        objectId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed inventory item ${objectId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embedding for a fact
   */
  async embedFact(factId: string, factText: string): Promise<boolean> {
    try {
      const embeddingString = await this.generateEmbeddingString(factText);
      await this.dataSource.query(`UPDATE ci.facts SET fact_embedding = $1 WHERE fact_id = $2`, [
        embeddingString,
        factId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed fact ${factId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embeddings for a document (title, content, summary)
   */
  async embedDocument(
    documentId: string,
    title?: string,
    content?: string,
    summary?: string,
  ): Promise<boolean> {
    try {
      if (title) {
        const titleEmbedding = await this.generateEmbeddingString(title);
        await this.dataSource.query(`UPDATE ci.documents SET title_embedding = $1 WHERE document_id = $2`, [
          titleEmbedding,
          documentId,
        ]);
      }

      if (content) {
        const contentEmbedding = await this.generateEmbeddingString(content);
        await this.dataSource.query(`UPDATE ci.documents SET content_embedding = $1 WHERE document_id = $2`, [
          contentEmbedding,
          documentId,
        ]);
      }

      if (summary) {
        const summaryEmbedding = await this.generateEmbeddingString(summary);
        await this.dataSource.query(`UPDATE ci.documents SET summary_embedding = $1 WHERE document_id = $2`, [
          summaryEmbedding,
          documentId,
        ]);
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed document ${documentId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embedding for a document chunk
   */
  async embedDocumentChunk(chunkId: string, chunkContent: string): Promise<boolean> {
    try {
      const embeddingString = await this.generateEmbeddingString(chunkContent);
      await this.dataSource.query(`UPDATE ci.document_chunks SET chunk_embedding = $1 WHERE chunk_id = $2`, [
        embeddingString,
        chunkId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed document chunk ${chunkId}: ${message}`);

      return false;
    }
  }

  /**
   * Generate and store embedding for a message
   */
  async embedMessage(messageId: string, content: string): Promise<boolean> {
    try {
      const embeddingString = await this.generateEmbeddingString(content);
      await this.dataSource.query(`UPDATE ci.messages SET message_embedding = $1 WHERE message_id = $2`, [
        embeddingString,
        messageId,
      ]);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to embed message ${messageId}: ${message}`);

      return false;
    }
  }

  // ==================== BULK EMBEDDING METHODS ====================

  /**
   * Find and embed all questions missing embeddings
   */
  async embedAllQuestions(): Promise<number> {
    const questions = await this.dataSource.query(`
      SELECT question_id, question_text
      FROM ci.questions
      WHERE question_embedding IS NULL
      AND question_text IS NOT NULL
    `);

    let successCount = 0;
    let failCount = 0;

    for (const question of questions) {
      const success = await this.embedQuestion(question.question_id, question.question_text);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} questions, failed ${failCount}`);
    }

    return successCount;
  }

  /**
   * Find and embed all answers missing embeddings
   */
  async embedAllAnswers(): Promise<number> {
    const answers = await this.dataSource.query(`
      SELECT answer_id, answer_text
      FROM ci.answers
      WHERE answer_embedding IS NULL
      AND answer_text IS NOT NULL
    `);

    let successCount = 0;
    let failCount = 0;

    for (const answer of answers) {
      const success = await this.embedAnswer(answer.answer_id, answer.answer_text);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} answers, failed ${failCount}`);
    }

    return successCount;
  }

  /**
   * Find and embed all content missing embeddings
   */
  async embedAllContent(): Promise<number> {
    const content = await this.dataSource.query(`
      SELECT id, text
      FROM ci.content
      WHERE embedding IS NULL
      AND text IS NOT NULL
    `);

    let successCount = 0;
    let failCount = 0;

    for (const item of content) {
      const success = await this.embedContent(item.id, item.text);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} content records, failed ${failCount}`);
    }

    return successCount;
  }

  /**
   * Find and embed all entities missing embeddings
   */
  async embedAllEntities(): Promise<number> {
    const entities = await this.dataSource.query(`
      SELECT entity_id, search_content
      FROM ci.entities
      WHERE embedding IS NULL
      AND search_content IS NOT NULL
    `);

    let successCount = 0;
    let failCount = 0;

    for (const entity of entities) {
      const success = await this.embedEntity(entity.entity_id, entity.search_content);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} entities, failed ${failCount}`);
    }

    return successCount;
  }

  /**
   * Find and embed all inventory items missing embeddings
   */
  async embedAllInventoryItems(): Promise<number> {
    const inventory = await this.dataSource.query(`
      SELECT object_id, name, description
      FROM ci.inventory
      WHERE object_embedding IS NULL
      AND (name IS NOT NULL OR description IS NOT NULL)
    `);

    let successCount = 0;
    let failCount = 0;

    for (const item of inventory) {
      const success = await this.embedInventoryItem(item.object_id, item.name, item.description);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} inventory items, failed ${failCount}`);
    }

    return successCount;
  }

  /**
   * Find and embed all facts missing embeddings
   */
  async embedAllFacts(): Promise<number> {
    const facts = await this.dataSource.query(`
      SELECT fact_id, fact_statement
      FROM ci.facts
      WHERE fact_embedding IS NULL
      AND fact_statement IS NOT NULL
    `);

    let successCount = 0;
    let failCount = 0;

    for (const fact of facts) {
      const success = await this.embedFact(fact.fact_id, fact.fact_statement);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} facts, failed ${failCount}`);
    }

    return successCount;
  }

  /**
   * Find and embed all documents missing embeddings
   */
  async embedAllDocuments(): Promise<number> {
    const documents = await this.dataSource.query(`
      SELECT document_id, title, content, summary
      FROM ci.documents
      WHERE (title_embedding IS NULL OR content_embedding IS NULL OR summary_embedding IS NULL)
      AND (title IS NOT NULL OR content IS NOT NULL OR summary IS NOT NULL)
    `);

    let successCount = 0;
    let failCount = 0;

    for (const doc of documents) {
      const success = await this.embedDocument(doc.document_id, doc.title, doc.content, doc.summary);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} documents, failed ${failCount}`);
    }

    return successCount;
  }

  /**
   * Find and embed all document chunks missing embeddings
   */
  async embedAllDocumentChunks(): Promise<number> {
    const chunks = await this.dataSource.query(`
      SELECT chunk_id, content
      FROM ci.document_chunks
      WHERE chunk_embedding IS NULL
      AND content IS NOT NULL
    `);

    let successCount = 0;
    let failCount = 0;

    for (const chunk of chunks) {
      const success = await this.embedDocumentChunk(chunk.chunk_id, chunk.content);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} document chunks, failed ${failCount}`);
    }

    return successCount;
  }

  /**
   * Find and embed all messages missing embeddings
   */
  async embedAllMessages(): Promise<number> {
    const messages = await this.dataSource.query(`
      SELECT message_id, content
      FROM ci.messages
      WHERE message_embedding IS NULL
      AND content IS NOT NULL
    `);

    let successCount = 0;
    let failCount = 0;

    for (const message of messages) {
      const success = await this.embedMessage(message.message_id, message.content);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.warn(`Embedded ${successCount} messages, failed ${failCount}`);
    }

    return successCount;
  }

  // ==================== LEGACY METHODS ====================

  async indexText(context: RequestContext, input: string) {
    return this.calculateVector(input);
  }

  async findAll(context: RequestContext): Promise<SearchResult[]> {
    return this.findNearest(context, '', undefined, 1000);
  }

  async findNearest(
    context: RequestContext,
    input: string,
    types?: string[],
    topK: number = 25,
  ): Promise<SearchResult[]> {
    const vector = await this.calculateVectorString(input);
    const searchTypes =
      Array.isArray(types) && types.length > 0
        ? types.filter((t) => ENTITY_CONFIG[t])
        : Object.keys(ENTITY_CONFIG);

    if (searchTypes.length === 0) {
      return [];
    }

    const unionQueries: string[] = [];
    const params: (string | number)[] = [vector];
    let paramIndex = 2;

    for (const type of searchTypes) {
      const config = ENTITY_CONFIG[type];

      let selectClause = `
        SELECT
          '${type}' as type,
          ${config.idColumn} as id,
          ${config.textColumn} as text,
          ${config.embeddingColumn} <-> $1 as distance
      `;

      if (config.userColumn) {
        selectClause += `, ${config.userColumn} as user_id`;
      } else {
        selectClause += `, NULL as user_id`;
      }

      selectClause += ` FROM ${config.table}`;

      const whereClauses: string[] = [];
      whereClauses.push(`${config.embeddingColumn} IS NOT NULL`);

      if (context.userId && config.userColumn) {
        whereClauses.push(`${config.userColumn} = $${paramIndex}`);
        params.push(context.userId);
        paramIndex++;
      }

      if (whereClauses.length > 0) {
        selectClause += ` WHERE ${whereClauses.join(' AND ')}`;
      }

      unionQueries.push(selectClause);
    }

    let sql = unionQueries.join(' UNION ALL ');
    sql += ` ORDER BY distance ASC LIMIT $${paramIndex}`;
    params.push(topK);

    const results = await this.dataSource.query(sql, params);

    return results.map(
      (row: { type: string; id: string; text: string; distance: string; user_id?: string }) => ({
        type: row.type,
        id: row.id,
        text: row.text,
        distance: parseFloat(row.distance),
        user_id: row.user_id,
      }),
    );
  }

  private async sha256(input: string) {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  private async calculateVector(input: string): Promise<number[]> {
    try {
      const response = await this.ollama.embeddings({
        model: EMBEDDING_MODEL,
        prompt: input,
      });

      if (!response.embedding || response.embedding.length === 0) {
        throw new Error('Received empty embedding vector from Ollama');
      }

      return response.embedding;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to generate embedding: ${message}`);
    }
  }

  private async calculateVectorString(input: string): Promise<string> {
    const vector = await this.calculateVector(input);

    return `[${vector.join(',')}]`;
  }
}
