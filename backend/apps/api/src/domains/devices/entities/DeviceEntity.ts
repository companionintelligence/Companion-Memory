import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import type { Device, DeviceType, DeviceStatus } from '../types';

@Entity({ name: 'devices' })
export class DeviceEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  type!: DeviceType;

  @Column({ type: 'text', default: 'disconnected' })
  status!: DeviceStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_seen' })
  lastSeen!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'ip_address' })
  ipAddress!: string | null;

  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent!: string | null;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  toDevice(): Device {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      status: this.status,
      lastSeen: this.lastSeen || undefined,
      ipAddress: this.ipAddress || undefined,
      userAgent: this.userAgent || undefined,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}