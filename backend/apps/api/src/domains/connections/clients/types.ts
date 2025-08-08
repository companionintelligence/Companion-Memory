export interface SyncResponse {
  success: boolean;
  message: string;
  data?: {
    results: SyncResult[];
    errors: string[];
  };
}

export interface SyncResult {
  api: string;
  data: unknown;
  error?: string;
}

export interface TokenExchange {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: Date | null;
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}
