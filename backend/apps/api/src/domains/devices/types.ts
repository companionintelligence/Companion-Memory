import { z } from 'zod';

import type { Device } from './entities/DeviceEntity';

// Validation schema for creating devices
export const createDeviceSchema = z.object({
  device_entity_id: z.string().uuid().optional(),
  device_name: z.string().min(1).optional(),
  device_type: z.enum([
    'smartphone',
    'laptop',
    'desktop',
    'tablet',
    'smartwatch',
    'smart_speaker',
    'smart_glasses',
    'iot_sensor',
    'browser',
  ]),
  platform: z.enum(['ios', 'android', 'windows', 'macos', 'linux', 'web']).optional(),
  model: z.string().optional(),
  manufacturer: z.string().optional(),
  os_version: z.string().optional(),
  app_version: z.string().optional(),
  is_active: z.boolean().optional(),
  is_primary: z.boolean().optional(),
  push_token: z.string().optional(),
  capabilities: z.record(z.unknown()).optional(),
  privacy_settings: z.record(z.unknown()).optional(),
});

export const updateDeviceSchema = createDeviceSchema.partial();

// DTOs
export interface CreateDeviceDto {
  device_entity_id?: string;
  device_name?: string;
  device_type:
    | 'smartphone'
    | 'laptop'
    | 'desktop'
    | 'tablet'
    | 'smartwatch'
    | 'smart_speaker'
    | 'smart_glasses'
    | 'iot_sensor'
    | 'browser';
  platform?: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'web';
  model?: string;
  manufacturer?: string;
  os_version?: string;
  app_version?: string;
  is_active?: boolean;
  is_primary?: boolean;
  push_token?: string;
  capabilities?: Record<string, unknown>;
  privacy_settings?: Record<string, unknown>;
}

export interface UpdateDeviceDto {
  device_entity_id?: string;
  device_name?: string;
  device_type?:
    | 'smartphone'
    | 'laptop'
    | 'desktop'
    | 'tablet'
    | 'smartwatch'
    | 'smart_speaker'
    | 'smart_glasses'
    | 'iot_sensor'
    | 'browser';
  platform?: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'web';
  model?: string;
  manufacturer?: string;
  os_version?: string;
  app_version?: string;
  is_active?: boolean;
  is_primary?: boolean;
  push_token?: string;
  capabilities?: Record<string, unknown>;
  privacy_settings?: Record<string, unknown>;
}

// Export the main type
export type { Device };
