// Home Assistant API Types and Interfaces

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id?: string;
    user_id?: string;
  };
}

export interface HomeAssistantConfig {
  latitude: number;
  longitude: number;
  elevation: number;
  unit_system: {
    length: string;
    mass: string;
    temperature: string;
    volume: string;
  };
  location_name: string;
  time_zone: string;
  version: string;
  config_dir: string;
  whitelist_external_dirs: string[];
  allowlist_external_dirs: string[];
}

export interface HomeAssistantService {
  domain: string;
  services: Record<string, {
    name: string;
    description: string;
    fields: Record<string, {
      name: string;
      description: string;
      required?: boolean;
      example?: any;
      default?: any;
      values?: string[];
    }>;
  }>;
}

// Location Tracking Types
export interface PersonState extends HomeAssistantState {
  attributes: {
    editable: boolean;
    id: string;
    device_trackers: string[];
    user_id?: string;
    latitude?: number;
    longitude?: number;
    gps_accuracy?: number;
    source?: string;
    friendly_name: string;
  };
}

export interface DeviceTrackerState extends HomeAssistantState {
  attributes: {
    latitude?: number;
    longitude?: number;
    gps_accuracy?: number;
    battery?: number;
    friendly_name: string;
    source_type: 'gps' | 'router' | 'bluetooth' | 'bluetooth_le';
  };
}

export interface ZoneState extends HomeAssistantState {
  attributes: {
    latitude: number;
    longitude: number;
    radius: number;
    friendly_name: string;
    icon?: string;
    passive?: boolean;
    persons?: string[];
  };
}

// Media Player Types
export interface MediaPlayerState extends HomeAssistantState {
  attributes: {
    volume_level?: number;
    is_volume_muted?: boolean;
    media_content_id?: string;
    media_content_type?: string;
    media_duration?: number;
    media_position?: number;
    media_position_updated_at?: string;
    media_title?: string;
    media_artist?: string;
    media_album_name?: string;
    media_album_artist?: string;
    media_track?: number;
    media_series_title?: string;
    media_season?: string;
    media_episode?: string;
    app_id?: string;
    app_name?: string;
    entity_picture?: string;
    friendly_name: string;
    supported_features: number;
    device_class?: 'tv' | 'speaker' | 'receiver';
    source?: string;
    source_list?: string[];
  };
}

// Light Control Types
export interface LightState extends HomeAssistantState {
  attributes: {
    min_color_temp_kelvin?: number;
    max_color_temp_kelvin?: number;
    min_mireds?: number;
    max_mireds?: number;
    supported_color_modes: string[];
    color_mode?: string;
    brightness?: number;
    color_temp_kelvin?: number;
    color_temp?: number;
    hs_color?: [number, number];
    rgb_color?: [number, number, number];
    xy_color?: [number, number];
    effect_list?: string[];
    effect?: string;
    friendly_name: string;
    supported_features: number;
  };
}

export interface LightControlParams {
  entity_id: string | string[];
  brightness?: number;
  brightness_pct?: number;
  color_name?: string;
  rgb_color?: [number, number, number];
  hs_color?: [number, number];
  xy_color?: [number, number];
  color_temp?: number;
  color_temp_kelvin?: number;
  white?: number;
  profile?: string;
  flash?: 'short' | 'long';
  effect?: string;
  transition?: number;
}

// Camera Types
export interface CameraState extends HomeAssistantState {
  attributes: {
    access_token: string;
    friendly_name: string;
    supported_features: number;
    frontend_stream_type?: string;
    entity_picture?: string;
    brand?: string;
    model_name?: string;
    motion_detection?: boolean;
  };
}

// Automation and Scene Types
export interface AutomationState extends HomeAssistantState {
  attributes: {
    id?: string;
    friendly_name: string;
    last_triggered?: string;
    mode: 'single' | 'restart' | 'queued' | 'parallel';
    current?: number;
    max?: number;
  };
}

export interface SceneState extends HomeAssistantState {
  attributes: {
    entity_id: string[];
    friendly_name: string;
    id?: string;
  };
}

// Service Call Types
export interface ServiceCallParams {
  domain: string;
  service: string;
  service_data?: Record<string, any>;
  target?: {
    entity_id?: string | string[];
    device_id?: string | string[];
    area_id?: string | string[];
  };
}

export interface ServiceCallResponse {
  context: {
    id: string;
    parent_id?: string;
    user_id?: string;
  };
}

// Notification Types
export interface NotificationParams {
  message: string;
  title?: string;
  target?: string | string[];
  data?: Record<string, any>;
}

// Conversation Types
export interface ConversationProcessParams {
  text: string;
  language?: string;
  agent_id?: string;
  conversation_id?: string;
}

export interface ConversationResponse {
  response: {
    speech: {
      plain: {
        speech: string;
        extra_data?: any;
      };
    };
    card?: any;
    language: string;
    response_type: 'action_done' | 'query_answer' | 'error';
  };
  conversation_id: string;
}

// Event Types for Real-time Integration
export interface HomeAssistantEvent {
  event_type: string;
  data: Record<string, any>;
  origin: string;
  time_fired: string;
  context: {
    id: string;
    parent_id?: string;
    user_id?: string;
  };
}

export interface StateChangedEvent extends HomeAssistantEvent {
  event_type: 'state_changed';
  data: {
    entity_id: string;
    old_state?: HomeAssistantState;
    new_state?: HomeAssistantState;
  };
}

// Webhook Types
export interface WebhookConfig {
  webhook_id: string;
  allowed_methods: string[];
  local_only: boolean;
}

// Integration Status Types
export interface HomeAssistantSyncStatus {
  location_tracking: {
    persons: number;
    device_trackers: number;
    zones: number;
    last_update?: string;
  };
  media_players: {
    total: number;
    active: number;
    playing: number;
    last_update?: string;
  };
  lights: {
    total: number;
    on: number;
    available: number;
    last_update?: string;
  };
  cameras: {
    total: number;
    active: number;
    motion_detected: number;
    last_update?: string;
  };
  automations: {
    total: number;
    enabled: number;
    last_triggered?: string;
  };
  scenes: {
    total: number;
    last_activated?: string;
  };
}