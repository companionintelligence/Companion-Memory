import { Repository } from 'typeorm';
import { BrokerTokenEntity } from '../entities/BrokerTokenEntity';
import { OAuthProviderService } from './OAuthProviderService';
import { CiServerService } from './CiServerService';
import type { AuthorizeRequestDto, AuthorizeResponseDto, TokenExchangeDto, BrokerToken } from '../types';
export declare class AuthBrokerService {
    private readonly brokerTokenRepository;
    private readonly oauthProviderService;
    private readonly ciServerService;
    private logger;
    private readonly stateStore;
    constructor(brokerTokenRepository: Repository<BrokerTokenEntity>, oauthProviderService: OAuthProviderService, ciServerService: CiServerService);
    authorize(userId: string, request: AuthorizeRequestDto): Promise<AuthorizeResponseDto>;
    exchangeToken(exchange: TokenExchangeDto): Promise<BrokerToken>;
    getUserTokens(userId: string): Promise<BrokerToken[]>;
    revokeToken(userId: string, tokenId: string): Promise<boolean>;
    private exchangeCodeForTokens;
    private tokenEntityToDto;
    private cleanupExpiredStates;
}
