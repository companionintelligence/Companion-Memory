import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as config from 'config';

export interface UserInfo {
  id: string;
  username: string;
  email: string;
}

@Injectable()
export class CiServerService {
  private readonly httpClient: AxiosInstance;

  constructor() {
    this.httpClient = axios.create({
      baseURL: config.get('ciServer.apiUrl'),
      timeout: 5000,
    });
  }

  async validateUserToken(token: string): Promise<UserInfo | null> {
    try {
      const response = await this.httpClient.get('/auth/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      
      return {
        id: response.data.id,
        username: response.data.username,
        email: response.data.email,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to validate user token:', errorMessage);
      return null;
    }
  }

  async notifyTokenUpdate(userId: string, providerId: string, hasToken: boolean): Promise<void> {
    try {
      await this.httpClient.post('/internal/oauth-tokens/update', {
        userId,
        providerId,
        hasToken,
      }, {
        headers: {
          'X-Internal-Secret': config.get('ciServer.internalSecret'),
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to notify CI-Server of token update:', errorMessage);
    }
  }
}