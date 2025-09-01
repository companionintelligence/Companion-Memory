import { OAuthProviderEntity } from './entities/OAuthProviderEntity';
import { BrokerTokenEntity } from './entities/BrokerTokenEntity';
import { AuthBrokerService } from './services/AuthBrokerService';
export declare class AuthBrokerModule {
}
export { OAuthProviderEntity, BrokerTokenEntity };
export { AuthBrokerService };
export type { AuthorizeRequestDto, AuthorizeResponseDto, TokenExchangeDto, BrokerToken, OAuthProvider, SupportedProvider } from './types';
