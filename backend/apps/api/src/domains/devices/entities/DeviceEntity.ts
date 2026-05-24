import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'devices' })
export class DeviceEntity {
  @PrimaryColumn({ type: 'uuid' })
  device_id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid', nullable: true })
  device_entity_id?: string;

  // Device identification
  @Column({ type: 'text' })
  device_name!: string;

  @Column({ type: 'text' })
  device_type!: string;

  // Device details
  @Column({ type: 'text', nullable: true })
  platform?: string;

  @Column({ type: 'text', nullable: true })
  model?: string;

  @Column({ type: 'text', nullable: true })
  manufacturer?: string;

  @Column({ type: 'text', nullable: true })
  os_version?: string;

  @Column({ type: 'text', nullable: true })
  app_version?: string;

  // Connection and status
  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  last_seen!: Date;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'boolean', default: false })
  is_primary!: boolean;

  @Column({ type: 'text', nullable: true })
  push_token?: string;

  // Capabilities and permissions
  @Column({ type: 'jsonb', default: '{}' })
  capabilities!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: '{}' })
  privacy_settings!: Record<string, unknown>;

  // Timestamps
  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | null;

  static toEgressType(entity: DeviceEntity): Device {
    return {
      device_id: entity.device_id,
      user_id: entity.user_id,
      device_entity_id: entity.device_entity_id,
      device_name: entity.device_name,
      device_type: entity.device_type,
      platform: entity.platform,
      model: entity.model,
      manufacturer: entity.manufacturer,
      os_version: entity.os_version,
      app_version: entity.app_version,
      last_seen: entity.last_seen,
      is_active: entity.is_active,
      is_primary: entity.is_primary,
      push_token: entity.push_token,
      capabilities: entity.capabilities,
      privacy_settings: entity.privacy_settings,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
      user: entity.user == null ? undefined : entity.user,
    };
  }
}

export type Device = Readonly<DeviceEntity>;
