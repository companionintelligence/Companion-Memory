import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user/entities/UserEntity';
import { DeviceDataEntity } from './DeviceDataEntity';

export type DevicePlatform = 'ios' | 'android' | 'windows' | 'mac';

@Entity({ name: 'devices' })
export class DeviceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 255, name: 'device_name' })
  deviceName!: string;

  @Column({ type: 'varchar', length: 50, name: 'platform' })
  platform!: DevicePlatform;

  @Column({ type: 'varchar', length: 255, name: 'device_identifier', unique: true })
  deviceIdentifier!: string;

  @Column({ type: 'varchar', length: 100, name: 'app_version', nullable: true })
  appVersion?: string;

  @Column({ type: 'varchar', length: 100, name: 'os_version', nullable: true })
  osVersion?: string;

  @Column({ type: 'jsonb', name: 'metadata', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'timestamptz', name: 'last_active_at', nullable: true })
  lastActiveAt?: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  // Relations
  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @OneToMany(() => DeviceDataEntity, (data) => data.device)
  data!: DeviceDataEntity[];
}