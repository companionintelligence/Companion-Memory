export interface LoginDto {
  username: string;
  password: string;
}

export interface SignupDto {
  name: string;
  email: string;
  password: string;
  signup_code?: string;
}

export interface JwtPayload {
  sub: string;
}

export interface SignedRequest extends Request {
  userId: string;
}

export interface SessionMetadata {
  ip?: string;
  userAgent?: string;
}

export interface UpdateSignupCodeDto {
  used?: boolean;
}

export interface RotationResult {
  sessionToken: string | null;
}

export interface CreateApiKeyDto {
  name: string;
  scopes?: string[];
  expires_at?: string;
}

export interface UpdateApiKeyDto {
  name?: string;
  scopes?: string[];
}

export interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateApiKeyResponse extends ApiKeyResponse {
  key: string;
}
