import { OAuthProviderEntity } from './OAuthProviderEntity';
export declare class BrokerTokenEntity {
    id: string;
    userId: string;
    providerId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    scopes: string[];
    tokenType: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
    provider: OAuthProviderEntity;
}
