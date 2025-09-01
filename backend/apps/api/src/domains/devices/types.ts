export type DeviceType =
  | 'quest3'
  | 'xreal-ultra'
  | 'xreal-one'
  | 'xreal-one-pro'
  | 'xreal-air-2'
  | 'ios'
  | 'android'
  | 'windows-app'
  | 'mac-app'
  | 'sipeed-maixcam'
  | 'sipeed-maixcam-pro'
  | 'omi-pendant'
  | 'omi-glasses';

export type DeviceStatus = 'connected' | 'disconnected' | 'authorized' | 'unauthorized';

export interface Device {
  readonly id: string;
  readonly name: string;
  readonly type: DeviceType;
  readonly status: DeviceStatus;
  readonly lastSeen?: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateDeviceDto {
  readonly name: string;
  readonly type: DeviceType;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface UpdateDeviceDto {
  readonly name?: string;
  readonly type?: DeviceType;
  readonly status?: DeviceStatus;
  readonly lastSeen?: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}