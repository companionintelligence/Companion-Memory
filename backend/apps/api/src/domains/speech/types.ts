export interface TTSConvertRequest {
  text: string;
  voice?: string;
}

export interface TTSConvertResponse {
  audio: string;
  sample_rate: number;
  duration?: number;
}

export interface VoiceProfileCreateRequest {
  name: string;
  description?: string;
  language?: string;
}

export interface VoiceProfile {
  id: string;
  name: string;
  description?: string;
  language: string;
  sample_count: number;
  created_at: string;
  updated_at: string;
}

export interface VoiceSynthesizeRequest {
  text: string;
  voice_id: string;
  speed?: number;
}
