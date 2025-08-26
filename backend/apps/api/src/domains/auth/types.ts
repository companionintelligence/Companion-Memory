export interface LoginDto {
  username: string;
  password: string;
}

export interface JwtPayload {
  sub: string;
}

export interface CreateSessionDto {
  token: string;
  ip?: string;
  userAgent?: string;
}

export interface RotateSessionDto {
  token: string;
  newToken: string;
  ip?: string;
  userAgent?: string;
}

export interface SignedRequest extends Request {
  userId: string;
}
