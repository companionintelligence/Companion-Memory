import GoogleEndpoints from './google-endpoints.json';
import MicrosoftEndpoints from './microsoft-endpoints.json';
import DropboxEndpoints from './dropbox-endpoints.json';
import MetaEndpoints from './meta-endpoints.json';
import type { ApiEndpointConfig } from '../types';

// Registry of all API endpoint configurations
export class ApiEndpointRegistry {
  private static endpoints = new Map<string, ApiEndpointConfig>();

  static {
    // Load endpoint configurations from JSON files
    this.loadEndpoints('google', GoogleEndpoints as ApiEndpointConfig[]);
    this.loadEndpoints('microsoft', MicrosoftEndpoints as ApiEndpointConfig[]);
    this.loadEndpoints('dropbox', DropboxEndpoints as ApiEndpointConfig[]);
    this.loadEndpoints('meta', MetaEndpoints as ApiEndpointConfig[]);
  }

  private static loadEndpoints(provider: string, endpoints: ApiEndpointConfig[]): void {
    endpoints.forEach(endpoint => {
      this.endpoints.set(endpoint.id, { ...endpoint, provider });
    });
  }

  static getEndpoint(id: string): ApiEndpointConfig | undefined {
    return this.endpoints.get(id);
  }

  static getEndpointsByProvider(provider: string): ApiEndpointConfig[] {
    return Array.from(this.endpoints.values()).filter(endpoint => endpoint.provider === provider);
  }

  static getAllEndpoints(): ApiEndpointConfig[] {
    return Array.from(this.endpoints.values());
  }

  static addEndpoint(endpoint: ApiEndpointConfig): void {
    this.endpoints.set(endpoint.id, endpoint);
  }
}