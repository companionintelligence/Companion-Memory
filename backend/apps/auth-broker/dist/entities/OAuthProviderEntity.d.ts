export declare class OAuthProviderEntity {
    id: string;
    name: string;
    displayName: string;
    clientId: string;
    clientSecret: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string[];
    redirectUri: string;
    active: boolean;
    logoUrl?: string;
    description?: string;
    createdAt: Date;
    updatedAt: Date;
}
