export interface OAuthProvider {
  name: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri: string;
  active: boolean;
}

export interface AuthorizeRequestDto {
  providerId: string;
  scopes?: string[];
  state?: string;
}

export interface AuthorizeResponseDto {
  authorizationUrl: string;
  state: string;
}

export interface TokenExchangeDto {
  providerId: string;
  code: string;
  state: string;
}

export interface BrokerToken {
  id: string;
  userId: string;
  providerId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SupportedProvider {
  id: string;
  name: string;
  displayName: string;
  scopes: string[];
  logoUrl?: string;
  description?: string;
}
