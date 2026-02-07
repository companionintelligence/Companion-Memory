import { Injectable, HttpException } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import type { Connection } from '@ci/domains/connections';

import type { EndpointSpec, ParamSpec } from '../types/api-spec';

/**
 * ApiClient handles making HTTP requests to provider APIs.
 * It supports template parameter substitution, pagination, and rate limiting.
 */
@Injectable()
export class ApiClient {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(ApiClient.name);
  }

  /**
   * Fetch data from an API endpoint
   * @param connection - The connection with auth credentials
   * @param endpoint - The endpoint specification
   * @param baseUrl - Base URL for the API
   * @returns Array of fetched data items
   */
  async fetch(
    connection: Connection,
    endpoint: EndpointSpec,
    baseUrl: string,
  ): Promise<unknown[]> {
    this.logger.log(`Fetching from endpoint: ${endpoint.name}`, {
      connectionId: connection.id,
      endpoint: endpoint.name,
    });

    const allData: unknown[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      try {
        // Build URL with parameters
        const url = this.buildUrl(baseUrl, endpoint, connection, pageToken);

        // Build headers
        const headers = this.buildHeaders(connection, endpoint);

        // Make HTTP request
        const response = await this.makeRequest(url, endpoint.method, headers);

        // Extract data from response
        const data = this.extractData(response, endpoint.dataPath);
        allData.push(...data);

        // Handle pagination
        if (endpoint.pagination && endpoint.responseType === 'collection') {
          pageToken = this.extractNextToken(response, endpoint);
          hasMore = !!pageToken;
        } else {
          hasMore = false;
        }

        // Log progress
        this.logger.debug(`Fetched ${data.length} items (total: ${allData.length})`);
      } catch (error) {
        this.logger.error('API request failed', {
          error,
          endpoint: endpoint.name,
          connectionId: connection.id,
        });
        throw error;
      }
    }

    return allData;
  }

  /**
   * Build request URL with parameter substitution
   */
  private buildUrl(
    baseUrl: string,
    endpoint: EndpointSpec,
    connection: Connection,
    pageToken?: string,
  ): string {
    let url = baseUrl + endpoint.path;

    // Build query parameters
    const params: Record<string, string> = {};
    const context = {
      connection,
      syncState: connection.syncState || {},
      parameters: {},
    };

    // Add query parameters from endpoint spec
    if (endpoint.queryParams) {
      for (const [key, paramSpec] of Object.entries(endpoint.queryParams)) {
        const value = this.resolveParamValue(paramSpec, context, pageToken);
        if (value !== null && value !== undefined) {
          params[key] = String(value);
        }
      }
    }

    // Add pagination token if provided
    if (pageToken && endpoint.pagination?.tokenParam) {
      params[endpoint.pagination.tokenParam] = pageToken;
    }

    // Append query string
    const queryString = new URLSearchParams(params).toString();
    if (queryString) {
      url += (url.includes('?') ? '&' : '?') + queryString;
    }

    return url;
  }

  /**
   * Resolve parameter value based on param spec
   */
  private resolveParamValue(
    paramSpec: ParamSpec,
    context: {
      connection: Connection;
      syncState: Record<string, unknown>;
      parameters: Record<string, unknown>;
    },
    pageToken?: string,
  ): unknown {
    switch (paramSpec.type) {
      case 'static':
        return paramSpec.value;

      case 'dynamic':
        if (paramSpec.source) {
          return this.extractNestedValue(context, paramSpec.source);
        }
        return paramSpec.default;

      case 'template':
        if (paramSpec.template) {
          const rendered = this.substituteTemplates(paramSpec.template, context);
          return rendered || paramSpec.default;
        }
        return paramSpec.default;

      default:
        return paramSpec.default;
    }
  }

  /**
   * Build request headers
   */
  private buildHeaders(connection: Connection, endpoint: EndpointSpec): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add OAuth token if available
    if (connection.accessToken) {
      headers['Authorization'] = `Bearer ${connection.accessToken}`;
    }

    // Add custom headers from endpoint spec
    if (endpoint.headers) {
      Object.assign(headers, endpoint.headers);
    }

    return headers;
  }

  /**
   * Make HTTP request
   */
  private async makeRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    try {
      const response = await fetch(url, {
        method,
        headers,
      });

      if (!response.ok) {
        throw new HttpException(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new Error(`Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Substitute template parameters in a string
   * Example: "{{ syncState.token }}" -> actual token value
   */
  private substituteTemplates(
    template: string,
    context: {
      connection: Connection;
      syncState?: Record<string, unknown>;
      parameters?: Record<string, unknown>;
    },
  ): string {
    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, path) => {
      const value = this.extractNestedValue(context, path.trim());
      return value !== null && value !== undefined ? String(value) : '';
    });
  }

  /**
   * Extract nested value from object
   */
  private extractNestedValue(obj: unknown, path: string): unknown {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }

    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Extract data from response based on dataPath
   */
  private extractData(response: unknown, dataPath?: string): unknown[] {
    if (!dataPath) {
      // If no dataPath, assume response is the data
      return Array.isArray(response) ? response : [response];
    }

    const data = this.extractNestedValue(response, dataPath);

    if (Array.isArray(data)) {
      return data;
    }

    // Single item
    return data !== null && data !== undefined ? [data] : [];
  }

  /**
   * Extract next page token from response
   */
  private extractNextToken(response: unknown, endpoint: EndpointSpec): string | null {
    if (!endpoint.pagination?.nextTokenField) {
      return null;
    }

    const token = this.extractNestedValue(response, endpoint.pagination.nextTokenField);
    return token ? String(token) : null;
  }
}
