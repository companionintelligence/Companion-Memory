import { Column, CreateDateColumn, Entity, PrimaryColumn, TableInheritance, UpdateDateColumn } from 'typeorm';

/**
 * Single-table-inheritance root for every entity persisted in the shared
 * `ci.entities` table.
 *
 * All concrete entity types (e.g. `PersonEntity`) extend this class and declare
 * `@ChildEntity('<discriminator>')`. TypeORM stores every type in this one
 * physical table, discriminated by the `entity_type` column, and manages that
 * column itself: it is set automatically on insert from the child's
 * discriminator value and used to auto-scope reads through a child's repository
 * (`getRepository(PersonEntity).find()` only returns `entity_type = 'Person'`
 * rows). For that reason the discriminator is declared via
 * {@link TableInheritance} and must NOT also be declared as a regular
 * `@Column`.
 *
 * This class is `abstract` so it is never instantiated directly in application
 * code; TypeORM still hydrates it at runtime for inheritance routing.
 */
@Entity({ schema: 'ci', name: 'entities' })
@TableInheritance({ column: { type: 'text', name: 'entity_type' } })
export abstract class BaseEntity {
  @PrimaryColumn('uuid', { name: 'entity_id' })
  id!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  @Column({ type: 'uuid', name: 'owner_user_id', nullable: true })
  userId?: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
