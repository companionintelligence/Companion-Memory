import { GoogleApiEndpoints } from './google-endpoints.json';
import { MicrosoftApiEndpoints } from './microsoft-endpoints.json';
import type { ApiEndpointConfig } from '../types';

// Registry of all API endpoint configurations
export class ApiEndpointRegistry {
  private static endpoints = new Map<string, ApiEndpointConfig>();

  static {
    // Load endpoint configurations from JSON files
    this.loadEndpoints('google', GoogleApiEndpoints);
    this.loadEndpoints('microsoft', MicrosoftApiEndpoints);
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