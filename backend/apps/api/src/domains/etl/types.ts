import type { Connection } from '../connections/types';
import type { User } from '../user';

// Geospatial point type for location data
export interface GeoPoint {
  readonly type: 'Point';
  readonly coordinates: [number, number]; // [longitude, latitude]
}

export interface ApiLog {
  readonly id: string;
  readonly user_id?: string;
  readonly connection_id?: string;
  readonly scope?: string;
  readonly content?: unknown;
  readonly embedding?: number[]; // Vector embedding for semantic search
  readonly location?: GeoPoint; // Geospatial location data
  readonly processed?: boolean; // Whether this log has been processed into events
  readonly user?: User;
  readonly connection?: Connection;
  readonly created_at: Date;
}
