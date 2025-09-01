import { Repository } from 'typeorm';
import { OAuthProviderEntity } from '../entities/OAuthProviderEntity';
import type { OAuthProvider, SupportedProvider } from '../types';
export declare class OAuthProviderService {
    private readonly oauthProviderRepository;
    private logger;
    constructor(oauthProviderRepository: Repository<OAuthProviderEntity>);
    findAll(): Promise<OAuthProviderEntity[]>;
    findById(id: string): Promise<OAuthProviderEntity | null>;
    findByName(name: string): Promise<OAuthProviderEntity | null>;
    getSupportedProviders(): Promise<SupportedProvider[]>;
    createProvider(providerData: Omit<OAuthProvider, 'active'>): Promise<OAuthProviderEntity>;
    updateProvider(id: string, updates: Partial<OAuthProvider>): Promise<OAuthProviderEntity | null>;
    deactivateProvider(id: string): Promise<boolean>;
}
