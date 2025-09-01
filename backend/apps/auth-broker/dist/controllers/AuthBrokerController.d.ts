import { AuthBrokerService } from '../services/AuthBrokerService';
import { OAuthProviderService } from '../services/OAuthProviderService';
import type { AuthorizeRequestDto } from '../types';
export declare class AuthBrokerController {
    private readonly authBrokerService;
    private readonly oauthProviderService;
    private logger;
    constructor(authBrokerService: AuthBrokerService, oauthProviderService: OAuthProviderService);
    getSupportedProviders(): Promise<import("../types").SupportedProvider[]>;
    authorize(req: any, body: AuthorizeRequestDto): Promise<import("../types").AuthorizeResponseDto>;
    callback(code: string, state: string, providerId: string): Promise<import("../types").BrokerToken>;
    getUserTokens(req: any): Promise<import("../types").BrokerToken[]>;
    revokeToken(req: any, tokenId: string): Promise<void>;
    refreshToken(req: any, tokenId: string): Promise<void>;
}
