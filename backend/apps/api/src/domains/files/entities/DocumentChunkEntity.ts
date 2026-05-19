import { Column, CreateDateColumn, Entity, PrimaryColumn, Unique } from 'typeorm';

/**
 * A single text chunk extracted from an uploaded file.
 * Used for RAG (retrieval-augmented generation) and semantic search over
 * user documents (plan 18).
 *
 * Embedding storage follows the EmbeddingEntity pattern: the `embedding`
 * column is TEXT in Postgres and serialised/deserialised as `number[]`
 * by a TypeORM column transformer.
 */
@Entity({ schema: 'ci', name: 'document_chunks' })
@Unique(['fileId', 'chunkIndex'])
export class DocumentChunkEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** Foreign key to `ci.files`. */
  @Column({ type: 'uuid', name: 'file_id' })
  fileId!: string;

  /** Owner of the file (denormalised for fast per-user queries). */
  @Column({ type: 'text', name: 'user_id' })
  userId!: string;

  /** Zero-based position within the source document. */
  @Column({ type: 'integer', name: 'chunk_index' })
  chunkIndex!: number;

  /** Raw extracted text of this chunk. */
  @Column({ type: 'text' })
  text!: string;

  /**
   * Embedding vector, serialised as a pgvector literal `[n1,n2,...]`.
   * `null` when the embedding job has not yet run or failed.
   */
  @Column({
    type: 'text',
    nullable: true,
    select: false,
    transformer: {
      to: (v: number[] | null) => (v ? `[${v.join(',')}]` : null),
      from: (v: string | null) => (v ? v.slice(1, -1).split(',').map(Number) : null),
    },
  })
  embedding!: number[] | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
