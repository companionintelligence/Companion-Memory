import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'entities' })
export class FileEntity {
  @PrimaryColumn('uuid', { name: 'entity_id' })
  id!: string;

  @Column({ type: 'text', name: 'entity_type', default: 'File' })
  entity_type!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  @Column({ type: 'text', nullable: false })
  linked_id!: string;

  @Column({ type: 'text', nullable: false })
  linked_table!: string;

  // Helper method for creating filtered queries
  static createFileQuery(
    repository: Repository<FileEntity>,
    alias: string = 'file',
  ): SelectQueryBuilder<FileEntity> {
    return repository
      .createQueryBuilder(alias)
      .where(`${alias}.entity_type = :entityType`, { entityType: 'File' });
  }

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'owner_user_id' })
  user?: UserEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
