import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AuthorizationCode } from 'simple-oauth2';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/services/LoggerService';
import type { RequestContext } from '@ci/common/types';

import { ConnectionEntity } from '../entities/ConnectionEntity';
import type { CreateConnectionDto, Connection, UpdateConnectionDto } from '../types';

@Injectable()
export class ConnectionService {
  private logger = new LoggerService(ConnectionService.name);
  private readonly apiUrl = process.env.API_URL || 'https://dev.companionintelligence.com';
  private readonly frontendUrl = process.env.FRONTEND_URL || 'https://dev.companionintelligence.com';

  constructor(
    @InjectRepository(ConnectionEntity)
    private readonly connectionRepository: Repository<ConnectionEntity>,
  ) {}

  async create(context: RequestContext, data: CreateConnectionDto): Promise<Connection> {
    const { providerId, ...rest } = data;

    const instance = this.connectionRepository.create({
      ...rest,
      id: uuid7(),
      active: true,
      user: {
        id: context.userId,
      },
      provider: {
        id: providerId,
      },
    });

    const entity = await this.connectionRepository.save(instance);

    return this.findOne(context, entity.id);
  }

  async findAll(context: RequestContext): Promise<Connection[]> {
    const entities = await this.connectionRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
      relations: ['provider'],
    });

    return entities.map((entity) => entity.toConnection());
  }

  async findAllActive(): Promise<Array<Connection & { userId: string }>> {
    const entities = await this.connectionRepository
      .createQueryBuilder('connection')
      .leftJoinAndSelect('connection.provider', 'provider')
      .leftJoinAndSelect('connection.user', 'user')
      .where('connection.active = :active', { active: true })
      .andWhere('connection.accessToken IS NOT NULL')
      .getMany();

    return entities.map((entity) => ({
      ...entity.toConnection(),
      userId: entity.user?.id || 'unknown',
    }));
  }

  async findOne(context: RequestContext, id: string): Promise<Connection> {
    const entity = await this.connectionRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
      relations: ['provider'],
    });

    if (entity == null) {
      throw new NotFoundException();
    }

    return entity.toConnection();
  }

  async update(context: RequestContext, id: string, data: UpdateConnectionDto): Promise<Connection> {
    const { providerId, ...updateData } = data;
    
    const updatePayload: any = { ...updateData };
    
    if (providerId) {
      updatePayload.provider = { id: providerId };
    }
    
    const result = await this.connectionRepository.update(
      {
        id,
        user: {
          id: context.userId,
        },
      },
      updatePayload,
    );

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return this.findOne(context, id);
  }

  async activate(context: RequestContext, id: string): Promise<Connection> {
    return this.update(context, id, { active: true });
  }

  async deactivate(context: RequestContext, id: string): Promise<Connection> {
    return this.update(context, id, { active: false });
  }

  async delete(context: RequestContext, id: string): Promise<boolean> {
    const result = await this.connectionRepository.delete({
      id,
      user: {
        id: context.userId,
      },
    });

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return true;
  }

  async sync(context: RequestContext, connectionId: string): Promise<{ success: boolean; message: string; data?: any }> {
    const connection = await this.findOne(context, connectionId);

    if (!connection.accessToken) {
      throw new NotFoundException('Connection not authenticated');
    }

    const provider = connection.provider;
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    this.logger.log('Starting manual sync for connection', {
      connectionId,
      providerName: provider.name,
      userId: context.userId,
    });

    const syncResults: any[] = [];
    const errors: string[] = [];

    try {
      // Handle Google connections
      if (provider.id === '018f8b9a-1234-7000-8000-000000000001') {
        await this.syncGoogleData(connection, syncResults, errors);
      }
      // Handle Microsoft connections
      else if (provider.id === '018f8b9a-1234-7000-8000-000000000006') {
        await this.syncMicrosoftData(connection, syncResults, errors);
      }
      else {
        throw new Error(`Unsupported provider: ${provider.name}`);
      }

      this.logger.log('Sync completed', {
        connectionId,
        successCount: syncResults.length,
        errorCount: errors.length,
        errors,
      });

      return {
        success: true,
        message: `Sync completed. ${syncResults.length} APIs processed successfully. ${errors.length} errors occurred.`,
        data: {
          results: syncResults,
          errors,
        },
      };
    } catch (error) {
      this.logger.error('Sync failed', {
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async syncGoogleData(connection: any, syncResults: any[], errors: string[]): Promise<void> {
    this.logger.log('Syncing Google data', { connectionId: connection.id });

    // Google Calendar API
    try {
      const calendarData = await this.makeApiRequest(
        { userId: connection.userId || connection.user?.id } as RequestContext,
        connection.id,
        '/calendar/v3/calendars/primary/events?maxResults=10&timeMin=' + new Date().toISOString(),
      );
      syncResults.push({ api: 'Google Calendar', data: calendarData });
      console.log('Google Calendar data:', calendarData);
    } catch (error) {
      const errorMsg = `Google Calendar API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      this.logger.error(errorMsg, { connectionId: connection.id, error });
    }

    // Gmail API
    try {
      const gmailData = await this.makeApiRequest(
        { userId: connection.userId || connection.user?.id } as RequestContext,
        connection.id,
        '/gmail/v1/users/me/messages?maxResults=10',
      );
      syncResults.push({ api: 'Gmail', data: gmailData });
      console.log('Gmail data:', gmailData);
    } catch (error) {
      const errorMsg = `Gmail API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      this.logger.error(errorMsg, { connectionId: connection.id, error });
    }

    // Google Drive API
    try {
      const driveData = await this.makeApiRequest(
        { userId: connection.userId || connection.user?.id } as RequestContext,
        connection.id,
        '/drive/v3/files?pageSize=10',
      );
      syncResults.push({ api: 'Google Drive', data: driveData });
      console.log('Google Drive data:', driveData);
    } catch (error) {
      const errorMsg = `Google Drive API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      this.logger.error(errorMsg, { connectionId: connection.id, error });
    }
  }

  private async syncMicrosoftData(connection: any, syncResults: any[], errors: string[]): Promise<void> {
    this.logger.log('Syncing Microsoft data', { connectionId: connection.id });

    // Microsoft Graph - User Profile
    try {
      const userData = await this.makeApiRequest(
        { userId: connection.userId || connection.user?.id } as RequestContext,
        connection.id,
        '/v1.0/me',
      );
      syncResults.push({ api: 'Microsoft Graph - User', data: userData });
      console.log('Microsoft User data:', userData);
    } catch (error) {
      const errorMsg = `Microsoft User API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      this.logger.error(errorMsg, { connectionId: connection.id, error });
    }

    // Microsoft Graph - Calendar
    try {
      const calendarData = await this.makeApiRequest(
        { userId: connection.userId || connection.user?.id } as RequestContext,
        connection.id,
        '/v1.0/me/calendar/events?$top=10',
      );
      syncResults.push({ api: 'Microsoft Graph - Calendar', data: calendarData });
      console.log('Microsoft Calendar data:', calendarData);
    } catch (error) {
      const errorMsg = `Microsoft Calendar API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      this.logger.error(errorMsg, { connectionId: connection.id, error });
    }

    // Microsoft Graph - Mail
    try {
      const mailData = await this.makeApiRequest(
        { userId: connection.userId || connection.user?.id } as RequestContext,
        connection.id,
        '/v1.0/me/messages?$top=10',
      );
      syncResults.push({ api: 'Microsoft Graph - Mail', data: mailData });
      console.log('Microsoft Mail data:', mailData);
    } catch (error) {
      const errorMsg = `Microsoft Mail API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      this.logger.error(errorMsg, { connectionId: connection.id, error });
    }

    // Microsoft Graph - OneDrive
    try {
      const onedriveData = await this.makeApiRequest(
        { userId: connection.userId || connection.user?.id } as RequestContext,
        connection.id,
        '/v1.0/me/drive/root/children?$top=10',
      );
      syncResults.push({ api: 'Microsoft Graph - OneDrive', data: onedriveData });
      console.log('Microsoft OneDrive data:', onedriveData);
    } catch (error) {
      const errorMsg = `Microsoft OneDrive API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      this.logger.error(errorMsg, { connectionId: connection.id, error });
    }
  }

  async connect(context: RequestContext, connectionId: string): Promise<{ url: string }> {
    const connection = await this.findOne(context, connectionId);

    if (!connection.clientid || !connection.clientsecret) {
      throw new NotFoundException('OAuth2 credentials not configured');
    }

    // Get provider OAuth2 configuration
    const provider = connection.provider;
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    // Create OAuth2 client based on provider configuration
    // Handle absolute URLs in authorizePath
    let authorizePath = provider.authorizePath || '/o/oauth2/v2/auth';
    let tokenHost = provider.tokenHost;

    // If authorizePath is an absolute URL, extract the host and path
    if (authorizePath.startsWith('http')) {
      const authUrl = new URL(authorizePath);
      tokenHost = `${authUrl.protocol}//${authUrl.host}`;
      authorizePath = authUrl.pathname + authUrl.search;
    }

    const client = new AuthorizationCode({
      client: {
        id: connection.clientid,
        secret: connection.clientsecret,
      },
      auth: {
        tokenHost: tokenHost,
        tokenPath: provider.tokenPath || '/token',
        authorizePath: authorizePath,
      },
    });

    // Prepare authorization parameters
    const authParams: any = {
      redirect_uri: `${this.frontendUrl}/oauth-callback.html`,
      scope: provider.scopes || '',
      state: connectionId, // Pass connection ID in state to identify it in callback
    };

    this.logger.debug('OAuth authorization parameters', {
      redirect_uri: authParams.redirect_uri,
      apiUrl: this.apiUrl,
      scope: provider.scopes,
      state: connectionId,
      envApiUrl: process.env.API_URL,
    });

    // Add tenant ID for Microsoft connections
    if (provider.id === '018f8b9a-1234-7000-8000-000000000006') {
      authParams.tenant = 'common';
    }

    const authorizationUri = client.authorizeURL(authParams);

    this.logger.debug('Generated authorization URL', {
      authorizationUri,
      redirect_uri: authParams.redirect_uri,
      tenant: authParams.tenant,
      fullUrl: authorizationUri,
    });

    return { url: authorizationUri };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callback(context: RequestContext): Promise<any> {
    this.logger.debug('OAuth2 callback received', {
      query: context.query,
      hasCode: !!context.query?.code,
      hasState: !!context.query?.state,
      contextUserId: context.userId,
      contextRequestId: context.requestId,
    });

    if (!context.query || !context.query.code || !context.query.state) {
      this.logger.error('OAuth2 callback missing code or state', {
        query: context.query,
      });
      throw new NotFoundException('Invalid callback parameters');
    }

    const connectionId = context.query.state as string;
    const code = context.query.code as string;

    this.logger.debug('Processing OAuth callback', { connectionId, codeLength: code.length });

    try {
      // Get the connection without user context (since this is an OAuth callback)
      this.logger.debug('Looking for connection in database', { connectionId });
      
      const entity = await this.connectionRepository.findOne({
        where: { id: connectionId },
        relations: ['provider', 'user'],
      });

      if (!entity) {
        this.logger.error('Connection not found in database', { connectionId });
        throw new NotFoundException('Connection not found');
      }

      this.logger.debug('Connection found in database', {
        connectionId,
        connectionName: entity.name,
        hasProvider: !!entity.provider,
        providerName: entity.provider?.name,
      });

      const connection = entity.toConnection();

      if (!connection.clientid || !connection.clientsecret) {
        throw new NotFoundException('OAuth2 credentials not configured');
      }

      const provider = connection.provider;
      if (!provider) {
        throw new NotFoundException('Provider not found');
      }

      // Create OAuth2 client
      // Handle absolute URLs in authorizePath
      let authorizePath = provider.authorizePath || '/o/oauth2/v2/auth';
      let tokenHost = provider.tokenHost;

      // If authorizePath is an absolute URL, extract the host and path
      if (authorizePath.startsWith('http')) {
        const authUrl = new URL(authorizePath);
        tokenHost = `${authUrl.protocol}//${authUrl.host}`;
        authorizePath = authUrl.pathname + authUrl.search;
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const client = new AuthorizationCode({
        client: {
          id: connection.clientid,
          secret: connection.clientsecret,
        },
        auth: {
          tokenHost: tokenHost,
          tokenPath: provider.tokenPath || '/token',
          authorizePath: authorizePath,
        },
      });

      // Exchange code for tokens
      // @todo note for Google, we need to make a direct POST request to handle the response properly
      this.logger.debug('Exchanging code for tokens');

      const tokenEndpoint = `${provider.tokenHost}${provider.tokenPath || '/token'}`;
      const tokenParams = new URLSearchParams({
        code,
        client_id: connection.clientid,
        client_secret: connection.clientsecret,
        redirect_uri: `${this.frontendUrl}/oauth-callback.html`,
        grant_type: 'authorization_code',
      });

      // Add tenant parameter for Microsoft connections
      if (provider.id === '018f8b9a-1234-7000-8000-000000000006') {
        tokenParams.append('tenant', 'common');
      }

      this.logger.debug('Making token request to:', tokenEndpoint);

      this.logger.debug('Token request body:', tokenParams.toString());

      const tokenResponse = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: tokenParams.toString(),
      });

      const responseText = await tokenResponse.text();
      this.logger.debug('Token response:', {
        status: tokenResponse.status,
        headers: Object.fromEntries(tokenResponse.headers.entries()),
        bodyPreview: responseText.substring(0, 200),
      });

      if (!tokenResponse.ok) {
        this.logger.error('Token exchange failed', {
          status: tokenResponse.status,
          statusText: tokenResponse.statusText,
          error: responseText,
        });
        throw new Error(`Token exchange failed: ${tokenResponse.statusText} - ${responseText}`);
      }

      let tokenData;
      try {
        tokenData = JSON.parse(responseText);
      } catch (parseError) {
        this.logger.error('Failed to parse token response as JSON', {
          responseText,
          parseError,
        });
        throw new Error('Invalid token response format');
      }

      this.logger.debug('Token exchange successful', {
        hasAccessToken: !!tokenData.access_token,
        hasRefreshToken: !!tokenData.refresh_token,
        hasExpiresIn: !!tokenData.expires_in,
      });

      // Store tokens in the connection entity
      const expiryDate = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

      this.logger.debug('About to store tokens in database', {
        connectionId,
        hasAccessToken: !!tokenData.access_token,
        hasRefreshToken: !!tokenData.refresh_token,
        expiryDate,
      });

      const updateResult = await this.connectionRepository.update(
        { id: connectionId },
        {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          tokenExpiry: expiryDate,
        },
      );

      this.logger.debug('Database update result', {
        connectionId,
        affectedRows: updateResult.affected,
        updateResult,
      });

      this.logger.debug('Tokens stored successfully for connection', { connectionId });

      // Get the updated connection data
      const updatedConnection = await this.findOne(
        { userId: entity.user.id, requestId: 'oauth-callback' } as RequestContext, 
        connectionId
      );

      // Redirect to frontend success page
      const redirectUrl = `${this.frontendUrl}/connections?oauth=success&connectionId=${connectionId}`;
      this.logger.debug('Redirecting to frontend', { redirectUrl, frontendUrl: this.frontendUrl });
      
      return {
        redirect: redirectUrl,
        connection: updatedConnection,
        connectionId: connectionId,
      };
    } catch (error) {
      this.logger.error('OAuth2 token exchange failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        connectionId,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new NotFoundException('Failed to complete OAuth2 flow');
    }
  }

  async makeApiRequest(
    context: RequestContext,
    connectionId: string,
    endpoint: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const connection = await this.findOne(context, connectionId);

    if (!connection.accessToken) {
      throw new NotFoundException('Connection not authenticated');
    }

    const provider = connection.provider;
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    // Check if token needs refresh
    if (connection.tokenExpiry && new Date(connection.tokenExpiry) < new Date()) {
      await this.refreshToken(context, connectionId);
      // Reload connection to get new tokens
      const refreshedConnection = await this.findOne(context, connectionId);
      connection.accessToken = refreshedConnection.accessToken;
    }

    // Make generic API request with the access token
    try {
      const response = await fetch(`${provider.apiBaseUrl}${endpoint}`, {
        ...options,
        headers: {
          ...options?.headers,
          Authorization: `Bearer ${connection.accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.error('API request failed', { connectionId, endpoint, error });
      throw error;
    }
  }

  private async refreshToken(context: RequestContext, connectionId: string): Promise<void> {
    const connection = await this.findOne(context, connectionId);

    if (!connection.refreshToken) {
      throw new NotFoundException('No refresh token available');
    }

    const provider = connection.provider;
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    // Handle absolute URLs in authorizePath
    let authorizePath = provider.authorizePath || '/o/oauth2/v2/auth';
    let tokenHost = provider.tokenHost;

    // If authorizePath is an absolute URL, extract the host and path
    if (authorizePath.startsWith('http')) {
      const authUrl = new URL(authorizePath);
      tokenHost = `${authUrl.protocol}//${authUrl.host}`;
      authorizePath = authUrl.pathname + authUrl.search;
    }

    const client = new AuthorizationCode({
      client: {
        id: connection.clientid!,
        secret: connection.clientsecret!,
      },
      auth: {
        tokenHost: tokenHost,
        tokenPath: provider.tokenPath || '/token',
        authorizePath: authorizePath,
      },
    });

    try {
      const accessToken = client.createToken({
        access_token: connection.accessToken!,
        refresh_token: connection.refreshToken,
        expires_at: connection.tokenExpiry,
      });

      const refreshedToken = await accessToken.refresh();

      // Update tokens in database
      await this.connectionRepository.update(
        {
          id: connectionId,
          user: {
            id: context.userId,
          },
        },
        {
          accessToken: refreshedToken.token.access_token,
          refreshToken: refreshedToken.token.refresh_token || connection.refreshToken,
          tokenExpiry: refreshedToken.token.expires_at,
        },
      );
    } catch (error) {
      this.logger.error('Token refresh failed', { connectionId, error });
      throw new NotFoundException('Failed to refresh token');
    }
  }
}
