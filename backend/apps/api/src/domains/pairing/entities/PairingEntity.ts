import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { UserEntity } from '@ci/domains/user';

export type PairingStatus = 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'NOT_FOUND';

@Entity({ schema: 'ci', name: 'pairings' })
export class PairingEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  pairing_token!: string;

  @Column({ type: 'text' })
  poll_key!: string;

  @Column({ type: 'text' })
  status!: PairingStatus;

  @ManyToOne(() => UserEntity, { nullable: true, eager: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | null;

  @Column({ type: 'text', nullable: true })
  device_id!: string | null;

  @Column({ type: 'text', nullable: true })
  access_token!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;
}
