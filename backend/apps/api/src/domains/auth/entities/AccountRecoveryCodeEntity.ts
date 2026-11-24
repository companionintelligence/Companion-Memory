import { Entity, Column, PrimaryColumn, CreateDateColumn, Index } from 'typeorm';

@Entity({ schema: 'ci', name: 'account_recovery_codes' })
@Index('account_recovery_codes_user_idx', ['userId'])
export class AccountRecoveryCodeEntity {
  @PrimaryColumn({ type: 'uuid' }) id!: string;

  @Column({ type: 'uuid', name: 'user_id' }) userId!: string;

  @Column({ type: 'text', name: 'code_digest', unique: true }) codeDigest!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'consumed_at', nullable: true }) consumedAt!: Date | null;
}
