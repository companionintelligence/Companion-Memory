import { z } from 'zod';

export const RegisterDeviceSchema = z.object({
  deviceName: z.string().min(1, 'Device name is required').max(255, 'Device name too long'),
  platform: z.enum(['ios', 'android', 'windows', 'mac']),
  deviceIdentifier: z.string().min(1, 'Device identifier is required').max(255, 'Device identifier too long'),
  appVersion: z.string().max(100, 'App version too long').optional(),
  osVersion: z.string().max(100, 'OS version too long').optional(),
  metadata: z.record(z.any()).optional(),
});

export type RegisterDeviceDto = z.infer<typeof RegisterDeviceSchema>;

export const UpdateDeviceSchema = z.object({
  deviceName: z.string().min(1, 'Device name is required').max(255, 'Device name too long').optional(),
  appVersion: z.string().max(100, 'App version too long').optional(),
  osVersion: z.string().max(100, 'OS version too long').optional(),
  metadata: z.record(z.any()).optional(),
});

export type UpdateDeviceDto = z.infer<typeof UpdateDeviceSchema>;

export const DeviceDataItemSchema = z.object({
  dataType: z.enum(['file_activity', 'app_usage', 'media_played', 'notification', 'location', 'device_usage', 'system_info']),
  timestamp: z.coerce.date(),
  payload: z.record(z.any()),
  sourceApp: z.string().max(255, 'Source app name too long').optional(),
  filePath: z.string().max(500, 'File path too long').optional(),
  fileType: z.string().max(100, 'File type too long').optional(),
  activityType: z.enum(['create', 'edit', 'open', 'delete', 'rename', 'move']).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  durationSeconds: z.number().int().min(0).optional(),
});

export type DeviceDataItemDto = z.infer<typeof DeviceDataItemSchema>;

export const IngestDeviceDataSchema = z.object({
  data: z.array(DeviceDataItemSchema).min(1, 'At least one data item is required').max(1000, 'Too many data items'),
});

export type IngestDeviceDataDto = z.infer<typeof IngestDeviceDataSchema>;

export const GetDeviceDataQuerySchema = z.object({
  dataType: z.enum(['file_activity', 'app_usage', 'media_played', 'notification', 'location', 'device_usage', 'system_info']).optional(),
  startTime: z.coerce.date().optional(),
  endTime: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type GetDeviceDataQueryDto = z.infer<typeof GetDeviceDataQuerySchema>;