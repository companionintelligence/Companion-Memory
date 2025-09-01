import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

import { DeviceEntity } from './DeviceEntity';

export type DataType = 
  | 'file_activity'
  | 'app_usage'
  | 'media_played'
  | 'notification'
  | 'location'
  | 'device_usage'
  | 'system_info';

export type FileActivityType = 'create' | 'edit' | 'open' | 'delete' | 'rename' | 'move';

@Entity({ name: 'device_data' })
@Index(['deviceId', 'dataType', 'timestamp'])
@Index(['deviceId', 'timestamp'])
export class DeviceDataEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  @Column({ type: 'varchar', length: 50, name: 'data_type' })
  dataType!: DataType;

  @Column({ type: 'timestamptz', name: 'timestamp' })
  timestamp!: Date;

  @Column({ type: 'jsonb', name: 'payload' })
  payload!: Record<string, any>;

  @Column({ type: 'varchar', length: 255, name: 'source_app', nullable: true })
  sourceApp?: string;

  @Column({ type: 'varchar', length: 500, name: 'file_path', nullable: true })
  filePath?: string;

  @Column({ type: 'varchar', length: 100, name: 'file_type', nullable: true })
  fileType?: string;

  @Column({ type: 'varchar', length: 50, name: 'activity_type', nullable: true })
  activityType?: FileActivityType;

  @Column({ type: 'decimal', precision: 10, scale: 7, name: 'latitude', nullable: true })
  latitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, name: 'longitude', nullable: true })
  longitude?: number;

  @Column({ type: 'integer', name: 'duration_seconds', nullable: true })
  durationSeconds?: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  // Relations
  @ManyToOne(() => DeviceEntity, (device) => device.data, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device!: DeviceEntity;
}