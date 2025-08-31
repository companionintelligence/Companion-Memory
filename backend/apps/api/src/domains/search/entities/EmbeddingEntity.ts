import { Entity, Column, CreateDateColumn, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { UserEntity } from '@ci/domains/user';

@Entity('embeddings')
export class EmbeddingEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  model!: string;

  @Column({ type: 'text' })
  raw_input!: string;

  @Column({ type: 'varchar', length: 64 })
  raw_input_hash!: string;

  @Column({ type: 'varchar', length: 100 })
  entity_type!: string;

  @Column({ type: 'varchar', length: 500 })
  data_path!: string;

  @Column({ type: 'uuid' })
  entity_id!: string;

  // Legacy text-based vector storage (kept for backward compatibility)
  @Column({
    type: 'text',
    transformer: {
      to: (v: number[]) => `[${v.join(',')}]`,
      from: (v: string) => v.slice(1, -1).split(',').map(Number),
    },
  })
  embedding_vector!: number[];

  // New native pgvector column for efficient similarity search
  @Column({ type: 'text', nullable: true }) // Using text type for now, will be cast to vector in database
  embedding_vector_native?: string; // pgvector type

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  // Helper method to get vector for similarity search
  getVectorForSearch(): string | number[] {
    return this.embedding_vector_native || this.embedding_vector;
  }

  // Helper method to convert legacy vector to native format
  convertToNativeVector(): void {
    if (this.embedding_vector && !this.embedding_vector_native) {
      this.embedding_vector_native = `[${this.embedding_vector.join(',')}]`;
    }
  }
}
