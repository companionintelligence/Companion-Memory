import config from '@ci/configuration';
import type {
  InstagramProfileSyncState,
  InstagramMediaSyncState,
  InstagramStoriesSyncState,
  InstagramDMSyncState,
  InstagramSyncState,
} from '@ci/domains/etl';

import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResponse, TokenExchange, TokenResponse } from './types';

interface InstagramUser {
  id: string;
  username: string;
  name: string;
  biography?: string;
  website?: string;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  account_type?: string;
}

interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | 'REELS';
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  username?: string;
  children?: {
    data: Array<{ id: string }>;
  };
  is_comment_enabled?: boolean;
  like_count?: number;
  comments_count?: number;
}

interface InstagramStory {
  id: string;
  media_type?: 'IMAGE' | 'VIDEO';
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  caption?: string;
}

interface InstagramComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  like_count?: number;
  hidden?: boolean;
  parent_id?: string;
  media_id?: string;
}

interface InstagramInsight {
  name: string;
  period: string;
  values: Array<{
    value: number | Record<string, unknown>;
    end_time: string;
  }>;
  title?: string;
  description?: string;
  id?: string;
}

interface InstagramConversation {
  id: string;
  updated_time?: string;
  message_count?: number;
  participants?: {
    data: Array<{
      id: string;
      username?: string;
    }>;
  };
}

interface InstagramMessage {
  id: string;
  created_time?: string;
  from?: {
    id: string;
    username?: string;
  };
  to?: {
    data: Array<{
      id: string;
      username?: string;
    }>;
  };
  message?: string;
}

export class InstagramClient extends BaseOAuth2Client {
  // Instagram Graph API uses graph.instagram.com for API calls
  protected readonly baseUrl = 'https://graph.instagram.com/v21.0';

  // Use Instagram's OAuth authorization endpoint for Instagram Business API
  protected readonly authorizationEndpoint = 'https://www.instagram.com/oauth/authorize';

  // Token exchange uses Instagram's endpoint
  protected readonly tokenEndpoint = 'https://api.instagram.com/oauth/access_token';

  // Instagram Business API scopes
  protected readonly scopes = [
    'instagram_business_basic',
    'instagram_business_manage_messages',
    'instagram_business_manage_comments',
    'instagram_business_content_publish',
    'instagram_business_manage_insights',
  ];

  protected get clientId() {
    const clientIdVariable = 'INSTAGRAM_CLIENT_ID';
    const clientId = process.env[clientIdVariable];

    if (!clientId) {
      this.logger.error(`Expected environment variable ${clientIdVariable} not specified`, {
        availableEnvVars: Object.keys(process.env).filter((key) => key.toUpperCase().includes('INSTAGRAM')),
      });

      throw new Error('Client id not configured for provider');
    }

    // Trim whitespace in case there are any spaces
    const trimmedClientId = clientId.trim();

    // Validate App ID format (Facebook App IDs are numeric, typically 15-16 digits)
    if (!/^\d{15,16}$/.test(trimmedClientId)) {
      this.logger.warn('Instagram Client ID format may be invalid', {
        clientId: trimmedClientId,
        clientIdLength: trimmedClientId.length,
        expectedFormat: '15-16 digit numeric string',
      });
    }

    this.logger.debug('Instagram client ID retrieved', {
      clientId: trimmedClientId,
      clientIdLength: trimmedClientId.length,
    });

    return trimmedClientId;
  }

  protected get clientSecret() {
    const clientSecretVariable = 'INSTAGRAM_CLIENT_SECRET';
    const clientSecret = process.env[clientSecretVariable];

    if (!clientSecret) {
      this.logger.error(`Expected environment variable ${clientSecretVariable} not specified`, {
        availableEnvVars: Object.keys(process.env).filter((key) => key.toUpperCase().includes('INSTAGRAM')),
      });

      throw new Error('Client secret not configured for provider');
    }

    this.logger.debug('Instagram client secret retrieved', {
      clientSecretLength: clientSecret.length,
    });

    return clientSecret;
  }

  /**
   * Override getAuthorizationUrl to ensure Facebook OAuth compatibility
   * Facebook requires the redirect_uri to be exactly as configured in the app settings
   */
  async getAuthorizationUrl(connection: Connection): Promise<string> {
    const clientId = this.clientId;
    const redirectUri = config.auth.oauth.callbackUrl;
    const scopes = this.scopes.join(','); // Instagram uses comma-separated scopes

    this.logger.log('Generating Instagram authorization URL', {
      connectionId: connection.id,
      clientId: clientId, // Log full client ID for debugging
      clientIdLength: clientId.length,
      redirectUri,
      scopes,
      authorizationEndpoint: this.authorizationEndpoint,
    });

    // Verify client ID format (Instagram App IDs are numeric strings, typically 15-16 digits)
    if (!/^\d+$/.test(clientId)) {
      this.logger.error('Instagram Client ID format appears invalid', {
        clientId,
        expectedFormat: 'Numeric string (15-16 digits)',
      });
    }

    const params = new URLSearchParams({
      force_reauth: 'true', // Force re-authentication to ensure fresh login
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      state: connection.id,
    });

    const authorizationUrl = `${this.authorizationEndpoint}?${params.toString()}`;

    this.logger.log('Instagram authorization URL generated', {
      connectionId: connection.id,
      urlLength: authorizationUrl.length,
      fullUrl: authorizationUrl, // Log full URL for debugging
    });

    return authorizationUrl;
  }

  /**
   * Exchange short-lived token for long-lived token (60 days)
   * Instagram provides short-lived tokens (1 hour) that need to be exchanged for long-lived tokens (60 days)
   */
  private async exchangeShortLivedForLongLived(shortLivedToken: string): Promise<TokenExchange> {
    const clientSecret = this.clientSecret;
    const exchangeUrl = 'https://graph.instagram.com/access_token';

    this.logger.log('Exchanging short-lived Instagram token for long-lived token', {
      tokenPreview: shortLivedToken.substring(0, 20) + '...',
      exchangeUrl,
    });

    const exchangeParams = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: clientSecret,
      access_token: shortLivedToken,
    });

    try {
      const exchangeResponse = await fetch(`${exchangeUrl}?${exchangeParams.toString()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      const responseText = await exchangeResponse.text();

      if (!exchangeResponse.ok) {
        let errorDetails: unknown;

        try {
          errorDetails = JSON.parse(responseText);
        } catch {
          errorDetails = responseText;
        }

        this.logger.error('Instagram long-lived token exchange failed', {
          status: exchangeResponse.status,
          statusText: exchangeResponse.statusText,
          error: errorDetails,
          endpoint: exchangeUrl,
        });

        // Try to extract Instagram's error message
        if (typeof errorDetails === 'object' && errorDetails !== null) {
          const igError = errorDetails as { error?: { message?: string; type?: string; code?: number } };
          if (igError.error?.message) {
            throw new Error(
              `Instagram API error: ${igError.error.message} (Type: ${igError.error.type}, Code: ${igError.error.code})`,
            );
          }
        }

        throw new Error(`Long-lived token exchange failed: ${responseText}`);
      }

      let tokenData: TokenResponse;

      try {
        tokenData = JSON.parse(responseText) as TokenResponse;
      } catch (parseError) {
        this.logger.error('Failed to parse Instagram long-lived token response', {
          responseText,
          parseError: parseError instanceof Error ? parseError.message : 'Unknown error',
        });

        throw new Error('Invalid long-lived token response format');
      }

      this.logger.log('Instagram long-lived token exchange successful', {
        hasAccessToken: !!tokenData.access_token,
        expiresIn: tokenData.expires_in,
        expiresInDays: tokenData.expires_in ? Math.round(tokenData.expires_in / 86400) : null,
      });

      const tokenExpiry = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

      // Instagram doesn't provide a separate refresh token
      // The long-lived token itself is used for refreshing
      // We store the long-lived token as both accessToken and refreshToken
      return {
        accessToken: tokenData.access_token || null,
        refreshToken: tokenData.access_token || null, // Long-lived token is used for refreshing
        tokenExpiry,
      } satisfies TokenExchange;
    } catch (error) {
      this.logger.error('Exception during Instagram long-lived token exchange', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        exchangeUrl,
      });

      throw error;
    }
  }

  /**
   * Override exchangeAuthorizationCode to:
   * 1. Get short-lived token (1 hour) from OAuth
   * 2. Immediately exchange it for long-lived token (60 days)
   * 3. Return the long-lived token
   */
  async exchangeAuthorizationCode(code: string): Promise<TokenExchange> {
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;
    const redirectUri = config.auth.oauth.callbackUrl;

    this.logger.log('Exchanging Instagram authorization code for short-lived token', {
      codeLength: code.length,
      codePreview: code.substring(0, 20) + '...',
      clientId: clientId.substring(0, 10) + '...',
      redirectUri,
      tokenEndpoint: this.tokenEndpoint,
    });

    const tokenParams = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    try {
      const tokenResponse = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: tokenParams.toString(),
      });

      const responseText = await tokenResponse.text();

      if (!tokenResponse.ok) {
        let errorDetails: unknown;

        try {
          errorDetails = JSON.parse(responseText);
        } catch {
          errorDetails = responseText;
        }

        this.logger.error('Instagram OAuth token exchange failed', {
          status: tokenResponse.status,
          statusText: tokenResponse.statusText,
          error: errorDetails,
          endpoint: this.tokenEndpoint,
          redirectUri,
          clientId: clientId.substring(0, 10) + '...',
        });

        // Try to extract error message
        if (typeof errorDetails === 'object' && errorDetails !== null) {
          const fbError = errorDetails as { error?: { message?: string; type?: string; code?: number } };
          if (fbError.error?.message) {
            throw new Error(
              `Instagram OAuth error: ${fbError.error.message} (Type: ${fbError.error.type}, Code: ${fbError.error.code})`,
            );
          }
        }

        throw new Error(`Token exchange failed: ${responseText}`);
      }

      let tokenData: TokenResponse;

      try {
        tokenData = JSON.parse(responseText) as TokenResponse;
      } catch (parseError) {
        this.logger.error('Failed to parse Instagram OAuth token response', {
          responseText,
          parseError: parseError instanceof Error ? parseError.message : 'Unknown error',
        });

        throw new Error('Invalid token response format');
      }

      if (!tokenData.access_token) {
        throw new Error('No access token received from Instagram OAuth');
      }

      this.logger.log('Instagram short-lived token obtained', {
        hasAccessToken: !!tokenData.access_token,
        expiresIn: tokenData.expires_in,
      });

      // Exchange short-lived token for long-lived token (60 days)
      const longLivedToken = await this.exchangeShortLivedForLongLived(tokenData.access_token);

      return longLivedToken;
    } catch (error) {
      this.logger.error('Exception during Instagram token exchange', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        tokenEndpoint: this.tokenEndpoint,
      });

      throw error;
    }
  }

  /**
   * Get the Instagram Business Account ID from the user's Facebook pages
   */
  /**
   * Helper method to make requests to Facebook Graph API (not Instagram Graph API)
   * This is needed for operations like getting the Instagram Business Account ID
   */
  private async requestFacebookAPI<T>(
    connection: Connection,
    endpoint: string,
    options?: RequestInit,
  ): Promise<T> {
    if (connection.accessToken == null) {
      throw new Error('Connection not authenticated');
    }

    const facebookBaseUrl = 'https://graph.facebook.com/v18.0';
    const response = await fetch(`${facebookBaseUrl}${endpoint}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${connection.accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error('Facebook API request failed', {
        status: response.status,
        statusText: response.statusText,
        endpoint: `${facebookBaseUrl}${endpoint}`,
        error: errorText,
      });
      throw new Error(`Facebook API request failed: ${response.statusText}`);
    }

    const data: T = await response.json();

    return data;
  }

  /**
   * Override refreshAccessToken to use Instagram's refresh endpoint
   * Instagram long-lived tokens can be refreshed using the token itself
   * The token must be at least 24 hours old but not expired
   */
  async refreshAccessToken(connection: Connection): Promise<TokenExchange> {
    if (!connection.refreshToken && !connection.accessToken) {
      throw new Error('No refresh token or access token available');
    }

    // Instagram uses the long-lived token itself for refreshing
    // Prefer refreshToken (which should be the long-lived token), fallback to accessToken
    const tokenToRefresh = connection.refreshToken || connection.accessToken;

    if (!tokenToRefresh) {
      throw new Error('No token available for refresh');
    }

    const refreshUrl = 'https://graph.instagram.com/refresh_access_token';

    this.logger.log('Refreshing Instagram long-lived token', {
      connectionId: connection.id,
      tokenPreview: tokenToRefresh.substring(0, 20) + '...',
      refreshUrl,
    });

    const refreshParams = new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: tokenToRefresh,
    });

    try {
      const refreshResponse = await fetch(`${refreshUrl}?${refreshParams.toString()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      const responseText = await refreshResponse.text();

      if (!refreshResponse.ok) {
        let errorDetails: unknown;

        try {
          errorDetails = JSON.parse(responseText);
        } catch {
          errorDetails = responseText;
        }

        this.logger.error('Instagram token refresh failed', {
          status: refreshResponse.status,
          statusText: refreshResponse.statusText,
          error: errorDetails,
          endpoint: refreshUrl,
          connectionId: connection.id,
        });

        // Try to extract Instagram's error message
        if (typeof errorDetails === 'object' && errorDetails !== null) {
          const igError = errorDetails as { error?: { message?: string; type?: string; code?: number } };
          if (igError.error?.message) {
            throw new Error(
              `Instagram API error: ${igError.error.message} (Type: ${igError.error.type}, Code: ${igError.error.code})`,
            );
          }
        }

        throw new Error(`Token refresh failed: ${responseText}`);
      }

      let tokenData: TokenResponse;

      try {
        tokenData = JSON.parse(responseText) as TokenResponse;
      } catch (parseError) {
        this.logger.error('Failed to parse Instagram refresh token response', {
          responseText,
          parseError: parseError instanceof Error ? parseError.message : 'Unknown error',
        });

        throw new Error('Invalid refresh token response format');
      }

      this.logger.log('Instagram token refresh successful', {
        connectionId: connection.id,
        hasAccessToken: !!tokenData.access_token,
        expiresIn: tokenData.expires_in,
        expiresInDays: tokenData.expires_in ? Math.round(tokenData.expires_in / 86400) : null,
      });

      const tokenExpiry = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

      // Instagram returns a new long-lived token that can be used for refreshing again
      return {
        accessToken: tokenData.access_token || null,
        refreshToken: tokenData.access_token || null, // New long-lived token is used for refreshing
        tokenExpiry,
      } satisfies TokenExchange;
    } catch (error) {
      this.logger.error('Exception during Instagram token refresh', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        refreshUrl,
        connectionId: connection.id,
      });

      throw error;
    }
  }

  private async getInstagramBusinessAccountId(connection: Connection): Promise<string> {
    // With Instagram OAuth, we can get the Instagram user ID directly from Instagram's API
    // The /me endpoint returns the authenticated Instagram user's ID
    try {
      const meResponse = await this.request<InstagramUser>(connection, '/me?fields=id');

      if (!meResponse.id) {
        throw new Error('Instagram user ID not found in response');
      }

      this.logger.log('Instagram user ID retrieved', {
        connectionId: connection.id,
        igUserId: meResponse.id,
      });

      return meResponse.id;
    } catch (error) {
      this.logger.error('Failed to get Instagram user ID', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error(
        `Failed to get Instagram user ID: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async sync(connection: Connection): Promise<SyncResponse[]> {
    const responses: SyncResponse[] = [];

    // Get Instagram Business Account ID
    let igUserId: string;
    try {
      igUserId = await this.getInstagramBusinessAccountId(connection);
    } catch (error) {
      const errorMsg = `Failed to get Instagram Business Account ID: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error(errorMsg, { connectionId: connection.id });

      responses.push({
        success: false,
        message: errorMsg,
        data: { results: [], errors: [errorMsg] },
      });

      return responses;
    }

    // Get existing Instagram sync state and accumulate updates
    const existingInstagramState = (connection.syncState?.instagram as InstagramSyncState | undefined) || {};
    const accumulatedInstagramState: InstagramSyncState = { ...existingInstagramState };

    // Sync profile
    const profileResponses = await this.syncProfile(connection, igUserId);
    // Update accumulated state with profile state
    if (profileResponses[0]?.cursor) {
      const cursor = profileResponses[0].cursor as Record<string, unknown>;
      if (cursor.instagram) {
        const profileState = (cursor.instagram as InstagramSyncState).profile;
        if (profileState) {
          accumulatedInstagramState.profile = profileState;
        }
      }

      // Update cursor to include full accumulated state
      profileResponses[0].cursor = { instagram: { ...accumulatedInstagramState } };
    }

    responses.push(...profileResponses);

    // Sync media
    const mediaResponses = await this.syncMedia(connection, igUserId, accumulatedInstagramState.media);
    // Update accumulated state with media state from last response
    for (const response of mediaResponses) {
      if (response.cursor) {
        const cursor = response.cursor as Record<string, unknown>;
        if (cursor.instagram) {
          const mediaState = (cursor.instagram as InstagramSyncState).media;
          if (mediaState) {
            accumulatedInstagramState.media = mediaState;
          }
        }

        // Update cursor to include full accumulated state
        response.cursor = { instagram: { ...accumulatedInstagramState } };
      }
    }

    responses.push(...mediaResponses);

    // Sync stories
    const storiesResponses = await this.syncStories(connection, igUserId, accumulatedInstagramState.stories);
    // Update accumulated state with stories state from last response
    for (const response of storiesResponses) {
      if (response.cursor) {
        const cursor = response.cursor as Record<string, unknown>;
        if (cursor.instagram) {
          const storiesState = (cursor.instagram as InstagramSyncState).stories;
          if (storiesState) {
            accumulatedInstagramState.stories = storiesState;
          }
        }

        // Update cursor to include full accumulated state
        response.cursor = { instagram: { ...accumulatedInstagramState } };
      }
    }

    responses.push(...storiesResponses);

    // Sync DMs
    const dmsResponses = await this.syncDMs(connection, igUserId, accumulatedInstagramState.dms);
    // Update accumulated state with DMs state from last response
    for (const response of dmsResponses) {
      if (response.cursor) {
        const cursor = response.cursor as Record<string, unknown>;
        if (cursor.instagram) {
          const dmsState = (cursor.instagram as InstagramSyncState).dms;
          if (dmsState) {
            accumulatedInstagramState.dms = dmsState;
          }
        }

        // Update cursor to include full accumulated state
        response.cursor = { instagram: { ...accumulatedInstagramState } };
      }
    }

    responses.push(...dmsResponses);

    return responses;
  }

  private async syncProfile(connection: Connection, igUserId: string): Promise<SyncResponse[]> {
    try {
      const fields = [
        'id',
        'username',
        'name',
        'biography',
        'website',
        'profile_picture_url',
        'followers_count',
        'follows_count',
        'media_count',
        'account_type',
      ].join(',');

      const profile = (await this.request<InstagramUser>(
        connection,
        `/${igUserId}?fields=${fields}`,
      )) as InstagramUser;

      const newSyncState: InstagramProfileSyncState = {
        lastSyncAt: new Date().toISOString(),
        igUserId: profile.id,
      };

      return [
        {
          success: true,
          message: 'Instagram Profile sync completed successfully',
          data: {
            results: [{ api: 'Profile', data: profile }],
            errors: [],
          },
          cursor: {
            instagram: {
              profile: newSyncState,
            },
          },
        },
      ];
    } catch (error) {
      const errorMsg = `Instagram Profile API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error(errorMsg, { connectionId: connection.id });

      return [
        {
          success: false,
          message: errorMsg,
          data: { results: [], errors: [errorMsg] },
        },
      ];
    }
  }

  /**
   * Fetch insights for a media item
   */
  private async fetchMediaInsights(
    connection: Connection,
    mediaId: string,
    mediaType: string,
  ): Promise<InstagramInsight[]> {
    const insights: InstagramInsight[] = [];

    // Different metrics based on media type
    // Note: 'engagement' is not a valid metric - use 'total_interactions' instead
    let metrics: string[];
    if (mediaType === 'REELS' || mediaType === 'VIDEO') {
      metrics = ['plays', 'reach', 'total_interactions', 'shares', 'saved'];
    } else if (mediaType === 'CAROUSEL_ALBUM') {
      metrics = ['impressions', 'reach', 'total_interactions', 'saved'];
    } else {
      // IMAGE
      metrics = ['impressions', 'reach', 'total_interactions', 'saved'];
    }

    for (const metric of metrics) {
      try {
        const insightResponse = (await this.request<{ data: InstagramInsight[] }>(
          connection,
          `/${mediaId}/insights?metric=${metric}`,
        )) as { data: InstagramInsight[] };
        insights.push(...(insightResponse.data || []));
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        // Handle expected errors gracefully:
        // - Media posted before business account conversion (expected for old posts)
        // - Invalid metrics for certain media types
        // - Metrics not supported for specific media product types
        if (
          errorMsg.includes("posted before the most recent time that the user's account was converted") ||
          errorMsg.includes('must be one of the following values') ||
          errorMsg.includes('does not support') ||
          errorMsg.includes('not support')
        ) {
          // These are expected errors - log at debug level
          this.logger.debug('Skipping insight metric (expected limitation)', {
            connectionId: connection.id,
            mediaId,
            metric,
            mediaType,
            reason: errorMsg.includes('posted before')
              ? 'pre-business-conversion-media'
              : errorMsg.includes('does not support') || errorMsg.includes('not support')
                ? 'metric-not-supported-for-media-type'
                : 'invalid-metric-for-media-type',
          });
        } else {
          // Unexpected errors - log at warn level
          this.logger.warn('Failed to fetch media insight', {
            connectionId: connection.id,
            mediaId,
            metric,
            mediaType,
            error: errorMsg,
          });
        }
      }
    }

    return insights;
  }

  /**
   * Fetch comments for a media item (with pagination)
   */
  private async fetchMediaComments(connection: Connection, mediaId: string): Promise<InstagramComment[]> {
    const allComments: InstagramComment[] = [];
    let afterCursor: string | undefined;

    do {
      try {
        const fields = 'id,text,timestamp,username,like_count,hidden,parent_id';
        let endpoint = `/${mediaId}/comments?fields=${fields}&limit=100`;
        if (afterCursor) {
          endpoint += `&after=${afterCursor}`;
        }

        const response = (await this.request<{
          data: InstagramComment[];
          paging?: {
            cursors?: {
              after?: string;
            };
            next?: string;
          };
        }>(connection, endpoint)) as {
          data: InstagramComment[];
          paging?: {
            cursors?: {
              after?: string;
            };
            next?: string;
          };
        };

        const comments = response.data || [];
        allComments.push(...comments);

        // Fetch replies for each comment
        for (const comment of comments) {
          try {
            const repliesResponse = (await this.request<{ data: InstagramComment[] }>(
              connection,
              `/${comment.id}/replies?fields=id,text,timestamp,username,like_count`,
            )) as { data: InstagramComment[] };
            (comment as InstagramComment & { replies?: InstagramComment[] }).replies =
              repliesResponse.data || [];
          } catch {
            // Ignore errors fetching replies
          }
        }

        afterCursor = response.paging?.cursors?.after;
      } catch (err) {
        this.logger.warn('Failed to fetch media comments', {
          connectionId: connection.id,
          mediaId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        break;
      }
    } while (afterCursor);

    return allComments;
  }

  private async syncMedia(
    connection: Connection,
    igUserId: string,
    syncState: InstagramMediaSyncState | null | undefined,
  ): Promise<SyncResponse[]> {
    const responses: SyncResponse[] = [];

    try {
      const fields = [
        'id',
        'caption',
        'media_type',
        'media_url',
        'thumbnail_url',
        'permalink',
        'timestamp',
        'username',
        'children',
        'is_comment_enabled',
        'like_count',
        'comments_count',
      ].join(',');

      // Use pagination cursor from sync state if available, otherwise start from beginning
      let endpoint = `/${igUserId}/media?fields=${fields}&limit=100`;
      if (syncState?.paginationCursor) {
        endpoint = `/${igUserId}/media?fields=${fields}&limit=100&after=${syncState.paginationCursor}`;
      }

      const response = (await this.request<{
        data: InstagramMedia[];
        paging?: {
          cursors?: {
            before?: string;
            after?: string;
          };
          next?: string;
        };
      }>(connection, endpoint)) as {
        data: InstagramMedia[];
        paging?: {
          cursors?: {
            before?: string;
            after?: string;
          };
          next?: string;
        };
      };

      const media = response.data || [];
      const afterCursor = response.paging?.cursors?.after;
      const hasNextPage = !!response.paging?.next;

      // For each media item, fetch all related data and create one aggregated API log entry
      for (const item of media) {
        try {
          // Fetch carousel children if needed
          if (item.media_type === 'CAROUSEL_ALBUM' && item.children?.data) {
            try {
              const childrenFields = 'id,media_type,media_url,thumbnail_url,permalink,timestamp';
              const childrenResponse = (await this.request<{ data: InstagramMedia[] }>(
                connection,
                `/${item.id}/children?fields=${childrenFields}`,
              )) as { data: InstagramMedia[] };
              item.children = { data: childrenResponse.data || [] };
            } catch (err) {
              this.logger.warn('Failed to fetch carousel children', {
                connectionId: connection.id,
                mediaId: item.id,
                error: err instanceof Error ? err.message : 'Unknown error',
              });
            }
          }

          // Fetch insights for this media item
          const insights = await this.fetchMediaInsights(connection, item.id, item.media_type);

          // Fetch comments for this media item
          const comments = await this.fetchMediaComments(connection, item.id);

          // Aggregate all data into one object
          const aggregatedMediaData = {
            ...item,
            insights,
            comments,
            // Track which endpoints were accessed (for scope field)
            _endpoints: [
              'media',
              'insights',
              'comments',
              ...(item.media_type === 'CAROUSEL_ALBUM' ? ['children'] : []),
            ],
          };

          // Create one API log entry per media item
          responses.push({
            success: true,
            message: `Instagram Media item ${item.id} synced with insights and comments`,
            data: {
              results: [
                {
                  api: 'media',
                  data: aggregatedMediaData,
                  // Note: scope field not in SyncResult type, but _endpoints is in data for reference
                },
              ],
              errors: [],
            },
            cursor: {
              instagram: {
                media: {
                  lastSyncAt: new Date().toISOString(),
                  lastMediaId: item.id,
                  paginationCursor: afterCursor,
                },
              },
            },
          });
        } catch (err) {
          const errorMsg = `Failed to sync media item ${item.id}: ${err instanceof Error ? err.message : 'Unknown error'}`;
          this.logger.error(errorMsg, {
            connectionId: connection.id,
            mediaId: item.id,
            error: err instanceof Error ? err.stack : undefined,
          });

          responses.push({
            success: false,
            message: errorMsg,
            data: { results: [], errors: [errorMsg] },
          });
        }
      }

      // Store the 'after' cursor for the next sync
      const newSyncState: InstagramMediaSyncState = {
        lastSyncAt: new Date().toISOString(),
        lastMediaId: media.length > 0 ? media[media.length - 1].id : syncState?.lastMediaId,
        paginationCursor: afterCursor, // Store cursor for next sync
      };

      this.logger.log('Instagram Media sync page completed', {
        connectionId: connection.id,
        pageMediaCount: media.length,
        hasNextPage,
        paginationCursor: afterCursor,
      });

      // Update all response cursors with the final sync state
      for (const response of responses) {
        if (response.cursor) {
          response.cursor = {
            instagram: {
              media: newSyncState,
            },
          };
        }
      }

      return responses;
    } catch (error) {
      const errorMsg = `Instagram Media API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error(errorMsg, { connectionId: connection.id });

      return [
        {
          success: false,
          message: errorMsg,
          data: { results: [], errors: [errorMsg] },
        },
      ];
    }
  }

  /**
   * Fetch insights for a story
   */
  private async fetchStoryInsights(connection: Connection, storyId: string): Promise<InstagramInsight[]> {
    const insights: InstagramInsight[] = [];

    // Story-specific metrics
    const metrics = ['impressions', 'reach', 'exits', 'replies', 'taps_forward', 'taps_back'];

    for (const metric of metrics) {
      try {
        const insightResponse = (await this.request<{ data: InstagramInsight[] }>(
          connection,
          `/${storyId}/insights?metric=${metric}`,
        )) as { data: InstagramInsight[] };
        insights.push(...(insightResponse.data || []));
      } catch (err) {
        // Some metrics may not be available - ignore errors
        this.logger.debug('Failed to fetch story insight', {
          connectionId: connection.id,
          storyId,
          metric,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return insights;
  }

  private async syncStories(
    connection: Connection,
    igUserId: string,
    syncState: InstagramStoriesSyncState | null | undefined,
  ): Promise<SyncResponse[]> {
    const responses: SyncResponse[] = [];

    try {
      // Stories endpoint: GET /{ig-user-id}/stories
      // Fields: id, media_type, media_url, permalink, timestamp, caption (rare; usually empty)
      const fields = 'id,media_type,media_url,permalink,timestamp,caption';
      let endpoint = `/${igUserId}/stories?fields=${fields}`;

      // Add pagination cursor if we have one from previous sync
      if (syncState?.paginationCursor) {
        endpoint += `&after=${syncState.paginationCursor}`;
      }

      this.logger.log('Fetching Instagram Stories', {
        connectionId: connection.id,
        igUserId,
        endpoint,
        hasPaginationCursor: !!syncState?.paginationCursor,
      });

      const response = (await this.request<{
        data: InstagramStory[];
        paging?: {
          cursors?: {
            before?: string;
            after?: string;
          };
          next?: string;
        };
      }>(connection, endpoint)) as {
        data: InstagramStory[];
        paging?: {
          cursors?: {
            before?: string;
            after?: string;
          };
          next?: string;
        };
      };

      const stories = response.data || [];
      const afterCursor = response.paging?.cursors?.after;
      const hasNextPage = !!response.paging?.next;

      // For each story, fetch insights and create one aggregated API log entry
      for (const story of stories) {
        try {
          // Fetch insights for this story
          const insights = await this.fetchStoryInsights(connection, story.id);

          // Aggregate all data into one object
          const aggregatedStoryData = {
            ...story,
            insights,
            // Track which endpoints were accessed (for scope field)
            _endpoints: ['stories', 'insights'],
          };

          // Create one API log entry per story
          responses.push({
            success: true,
            message: `Instagram Story ${story.id} synced with insights`,
            data: {
              results: [
                {
                  api: 'media',
                  data: aggregatedStoryData,
                  // Note: scope field not in SyncResult type, but _endpoints is in data for reference
                },
              ],
              errors: [],
            },
            cursor: {
              instagram: {
                stories: {
                  lastSyncAt: new Date().toISOString(),
                  paginationCursor: afterCursor,
                },
              },
            },
          });
        } catch (err) {
          const errorMsg = `Failed to sync story ${story.id}: ${err instanceof Error ? err.message : 'Unknown error'}`;
          this.logger.error(errorMsg, {
            connectionId: connection.id,
            storyId: story.id,
            error: err instanceof Error ? err.stack : undefined,
          });

          responses.push({
            success: false,
            message: errorMsg,
            data: { results: [], errors: [errorMsg] },
          });
        }
      }

      // Store the 'after' cursor for the next sync
      const newSyncState: InstagramStoriesSyncState = {
        lastSyncAt: new Date().toISOString(),
        paginationCursor: afterCursor, // Store cursor for next sync
      };

      this.logger.log('Instagram Stories sync page completed', {
        connectionId: connection.id,
        pageStoriesCount: stories.length,
        hasNextPage,
        paginationCursor: afterCursor,
      });

      // Update all response cursors with the final sync state
      for (const response of responses) {
        if (response.cursor) {
          response.cursor = {
            instagram: {
              stories: newSyncState,
            },
          };
        }
      }

      return responses;
    } catch (error) {
      const errorMsg = `Instagram Stories API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error(errorMsg, {
        connectionId: connection.id,
        igUserId,
        error: error instanceof Error ? error.stack : undefined,
      });

      return [
        {
          success: false,
          message: errorMsg,
          data: { results: [], errors: [errorMsg] },
        },
      ];
    }
  }

  /**
   * Fetch all messages for a conversation with pagination
   * Returns all messages and conversation metadata, or null if fetching fails
   */
  private async fetchAllMessagesForConversation(
    connection: Connection,
    conversationId: string,
    messagePaginationCursor?: string,
  ): Promise<{
    allMessages: InstagramMessage[];
    participants: Array<{ id: string; username?: string }>;
    updatedTime?: string;
  } | null> {
    const allMessages: InstagramMessage[] = [];
    let currentCursor = messagePaginationCursor;
    let participants: Array<{ id: string; username?: string }> = [];
    let updatedTime: string | undefined;

    this.logger.log('Fetching all messages for conversation', {
      connectionId: connection.id,
      conversationId,
      hasInitialCursor: !!messagePaginationCursor,
    });

    try {
      do {
        const messagesFields = 'id,created_time,from,to,message';
        // Instagram Graph API uses nested field syntax with pagination
        // Format: messages.after(cursor){fields} or just messages{fields} for first page
        // Requires platform=instagram parameter
        let messagesEndpoint = `/${conversationId}?platform=instagram&fields=messages`;
        if (currentCursor) {
          messagesEndpoint += `.after(${currentCursor})`;
        }

        messagesEndpoint += `{${messagesFields}},participants,updated_time`;

        // Messages endpoint is on Instagram Graph API
        const messagesResponse = (await this.request<{
          messages?: {
            data: InstagramMessage[];
            paging?: {
              cursors?: {
                after?: string;
              };
              next?: string;
            };
          };
          participants?: {
            data: Array<{
              id: string;
              username?: string;
            }>;
          };
          updated_time?: string;
        }>(connection, messagesEndpoint)) as {
          messages?: {
            data: InstagramMessage[];
            paging?: {
              cursors?: {
                after?: string;
              };
              next?: string;
            };
          };
          participants?: {
            data: Array<{
              id: string;
              username?: string;
            }>;
          };
          updated_time?: string;
        };

        const messages = messagesResponse.messages?.data || [];
        allMessages.push(...messages);

        // Store participants and updated time from first page
        if (allMessages.length === messages.length) {
          participants = messagesResponse.participants?.data || [];
          updatedTime = messagesResponse.updated_time;
        }

        currentCursor = messagesResponse.messages?.paging?.cursors?.after;
      } while (currentCursor);

      this.logger.log('Finished fetching messages for conversation', {
        connectionId: connection.id,
        conversationId,
        totalMessages: allMessages.length,
      });

      return {
        allMessages,
        participants,
        updatedTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('Failed to fetch messages for conversation', {
        connectionId: connection.id,
        conversationId,
        error: errorMsg,
        messagesFetchedSoFar: allMessages.length,
      });

      // Return null to indicate failure, but don't throw - we'll still save conversation data
      return null;
    }
  }

  private async syncDMs(
    connection: Connection,
    igUserId: string,
    syncState: InstagramDMSyncState | null | undefined,
  ): Promise<SyncResponse[]> {
    const responses: SyncResponse[] = [];

    this.logger.log('Starting Instagram DMs sync', {
      connectionId: connection.id,
      igUserId,
      hasCurrentConversationId: !!syncState?.currentConversationId,
      hasConversationCursor: !!syncState?.conversationPaginationCursor,
    });

    try {
      // If we have a current conversation ID, we're resuming a conversation
      // Refetch all messages from the beginning to ensure we have complete data for the blob
      if (syncState?.currentConversationId) {
        this.logger.log('Resuming conversation sync', {
          connectionId: connection.id,
          conversationId: syncState.currentConversationId,
        });
        const conversationId = syncState.currentConversationId;
        // Refetch from beginning to ensure completeness - don't use cursor
        const messagesResult = await this.fetchAllMessagesForConversation(connection, conversationId);

        // Get conversation metadata even if messages failed
        let conversationData: InstagramConversation | null = null;
        try {
          const conversationResponse = (await this.request<InstagramConversation>(
            connection,
            `/${conversationId}?platform=instagram&fields=id,updated_time,message_count,participants`,
          )) as InstagramConversation;
          conversationData = conversationResponse;
        } catch (error) {
          this.logger.warn('Failed to fetch conversation metadata', {
            connectionId: connection.id,
            conversationId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        // Create comprehensive conversation blob with all data
        const conversationBlob = {
          conversation: conversationData
            ? {
                id: conversationData.id,
                updatedTime: conversationData.updated_time,
                messageCount: conversationData.message_count,
                participants: conversationData.participants?.data || [],
              }
            : {
                id: conversationId,
                updatedTime: messagesResult?.updatedTime,
                messageCount: messagesResult?.allMessages.length || 0,
                participants: messagesResult?.participants || [],
              },
          participants: messagesResult?.participants || conversationData?.participants?.data || [],
          updatedTime: messagesResult?.updatedTime || conversationData?.updated_time,
          messages: messagesResult?.allMessages || [],
          messageCount: messagesResult?.allMessages.length || 0,
          messagesFetched: messagesResult !== null,
        };

        responses.push({
          success: true,
          message: `Instagram DMs sync for conversation ${conversationId}: ${conversationBlob.messageCount} messages`,
          data: {
            results: [
              {
                api: 'DMs',
                data: conversationBlob,
              },
            ],
            errors: messagesResult === null ? ['Failed to fetch some messages'] : [],
          },
          cursor: {
            instagram: {
              dms: {
                lastSyncAt: new Date().toISOString(),
                conversationPaginationCursor: syncState.conversationPaginationCursor,
                // Clear currentConversationId and messagePaginationCursor to fetch next conversation
              },
            },
          },
        });

        return responses;
      }

      // Otherwise, get next conversation(s) to process
      const fields = 'id,updated_time,message_count,participants';
      let conversationsEndpoint = `/${igUserId}/conversations?platform=instagram&fields=${fields}&limit=100`;
      if (syncState?.conversationPaginationCursor) {
        conversationsEndpoint = `/${igUserId}/conversations?platform=instagram&fields=${fields}&limit=100&after=${syncState.conversationPaginationCursor}`;
      }

      this.logger.log('Fetching Instagram conversations', {
        connectionId: connection.id,
        igUserId,
        endpoint: conversationsEndpoint,
        hasPaginationCursor: !!syncState?.conversationPaginationCursor,
      });

      // Conversations endpoint is on Instagram Graph API with platform=instagram parameter
      const conversationsResponse = (await this.request<{
        data: InstagramConversation[];
        paging?: {
          cursors?: {
            after?: string;
          };
          next?: string;
        };
      }>(connection, conversationsEndpoint)) as {
        data: InstagramConversation[];
        paging?: {
          cursors?: {
            after?: string;
          };
          next?: string;
        };
      };

      const conversations = conversationsResponse.data || [];
      const conversationAfterCursor = conversationsResponse.paging?.cursors?.after;
      const hasMoreConversations = !!conversationsResponse.paging?.next;

      this.logger.log('Instagram conversations fetched', {
        connectionId: connection.id,
        conversationCount: conversations.length,
        hasMoreConversations,
        conversationAfterCursor: conversationAfterCursor ? 'present' : 'none',
      });

      if (conversations.length === 0) {
        // No more conversations
        this.logger.log('No Instagram conversations found', {
          connectionId: connection.id,
          igUserId,
        });

        return [
          {
            success: true,
            message: 'Instagram DMs sync completed (no more conversations)',
            data: { results: [], errors: [] },
            cursor: {
              instagram: {
                dms: {
                  lastSyncAt: new Date().toISOString(),
                },
              },
            },
          },
        ];
      }

      // Process the first conversation: fetch all messages and save as complete blob
      const conversation = conversations[0];
      this.logger.log('Fetching messages for conversation', {
        connectionId: connection.id,
        conversationId: conversation.id,
        messageCount: conversation.message_count,
      });
      const messagesResult = await this.fetchAllMessagesForConversation(connection, conversation.id);

      // Create comprehensive conversation blob with all data
      const conversationBlob = {
        conversation: {
          id: conversation.id,
          updatedTime: conversation.updated_time,
          messageCount: conversation.message_count,
          participants: conversation.participants?.data || [],
        },
        participants: messagesResult?.participants || conversation.participants?.data || [],
        updatedTime: messagesResult?.updatedTime || conversation.updated_time,
        messages: messagesResult?.allMessages || [],
        messageCount: messagesResult?.allMessages.length || 0,
        messagesFetched: messagesResult !== null,
      };

      responses.push({
        success: true,
        message: `Instagram DMs sync for conversation ${conversation.id}: ${conversationBlob.messageCount} messages${hasMoreConversations ? ' (more conversations available)' : ''}`,
        data: {
          results: [
            {
              api: 'DMs',
              data: conversationBlob,
            },
          ],
          errors: messagesResult === null ? ['Failed to fetch some messages'] : [],
        },
        cursor: {
          instagram: {
            dms: {
              lastSyncAt: new Date().toISOString(),
              lastConversationId: conversation.id,
              conversationPaginationCursor: conversationAfterCursor, // Store cursor for conversation pagination
              // Will set currentConversationId and messagePaginationCursor if there are more messages to fetch
            },
          },
        },
      });

      return responses;
    } catch (error) {
      const errorMsg = `Instagram DMs API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error('Instagram DMs sync failed', {
        connectionId: connection.id,
        igUserId,
        error: errorMsg,
        errorDetails: error instanceof Error ? error.stack : undefined,
      });

      return [
        {
          success: false,
          message: errorMsg,
          data: { results: [], errors: [errorMsg] },
        },
      ];
    }
  }
}
