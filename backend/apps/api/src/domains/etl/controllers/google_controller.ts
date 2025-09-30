import { Controller } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';
import { ConnectionService } from '@ci/domains/connections';
import { SyncStateHelper } from '@ci/domains/connections/types/sync-state';

import { ApiLogService } from '../services/ApiLogService';
import { EventProcessorService } from '../services/EventProcessorService';

@Controller('google')
export class GoogleController {
  private logger = new LoggerService(GoogleController.name);

  constructor(
    private readonly apiLogService: ApiLogService,
    private readonly connectionService: ConnectionService,
    private readonly eventProcessorService: EventProcessorService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE) // Every minute
  async cronCheckGoogleConnections() {
    this.logger.log('Google cron job triggered', {
      featureEnabled: config.features['scheduled.google.sync'],
    });

    if (!config.features['scheduled.google.sync']) {
      this.logger.log('Google sync feature is disabled');

      return;
    }

    this.logger.log('Checking Google connections for sync');

    try {
      // Get all active Google connections
      const googleConnections = await this.connectionService.findActiveGoogleConnections();

      this.logger.log(`Found ${googleConnections.length} active Google connections`);

      // Debug: Check what's in the database for sync state
      for (const conn of googleConnections) {
        this.logger.log('Connection sync state debug', {
          connectionId: conn.id,
          syncState: conn.syncState,
          syncStateType: typeof conn.syncState,
          syncStateString: JSON.stringify(conn.syncState),
        });
      }

      for (const connection of googleConnections) {
        this.logger.log('Checking connection for sync', {
          connectionId: connection.id,
          userId: connection.userId,
          hasSyncState: !!connection.syncState,
          syncStateKeys: connection.syncState ? Object.keys(connection.syncState) : [],
          calendarSyncToken: (connection.syncState?.calendar as Record<string, unknown>)?.syncToken,
          gmailHistoryId: (connection.syncState?.gmail as Record<string, unknown>)?.lastHistoryId,
          fullSyncState: connection.syncState,
        });

        // Check if connection needs sync based on schedule or last sync time
        if (this.shouldSyncConnection(connection)) {
          this.logger.log('Starting Google sync directly', {
            connectionId: connection.id,
            userId: connection.userId,
          });

          // Handle Google sync directly instead of using events to avoid duplication
          await this.handleGoogleDataSync({
            connectionId: connection.id,
            userId: connection.userId,
          });
        }
      }
    } catch (error) {
      this.logger.error('Error checking Google connections', error as Error);
    }
  }

  async handleGoogleDataSync(payload: { connectionId: string; userId: string }) {
    this.logger.log('Processing Google data sync', {
      connectionId: payload.connectionId,
      userId: payload.userId,
    });

    try {
      // Get the connection details
      const connection = await this.connectionService.findById(payload.connectionId);

      if (!connection) {
        this.logger.warn('Connection not found', {
          connectionId: payload.connectionId,
        });

        return;
      }

      // Handle each API separately with proper pagination
      const syncResults = [];
      const errors = [];

      // Google Calendar API - Handle pagination properly
      try {
        const calendarResult = await this.syncCalendarWithPagination(connection, payload.userId!);
        syncResults.push(calendarResult);
      } catch (error) {
        const errorMsg = `Google Calendar API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        this.logger.error('Calendar sync failed', { connectionId: payload.connectionId, error: errorMsg });
        errors.push(errorMsg);
      }

      // Gmail API - Handle pagination properly
      try {
        const gmailResult = await this.syncGmailWithPagination(connection, payload.userId!);
        syncResults.push(gmailResult);
      } catch (error) {
        const errorMsg = `Gmail API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        this.logger.error('Gmail sync failed', { connectionId: payload.connectionId, error: errorMsg });
        errors.push(errorMsg);
      }

      // Google Drive API - Simple sync (no pagination needed for now)
      try {
        const driveData = await this.connectionService.makePaginatedRequest(
          payload.connectionId,
          '/drive/v3/files?pageSize=10',
        );

        await this.apiLogService.create({
          content: driveData,
          userId: payload.userId!,
          connectionId: payload.connectionId,
          scope: 'Google Drive',
        });

        syncResults.push({ api: 'Google Drive', syncState: null });

        this.logger.log('Drive sync completed', {
          connectionId: payload.connectionId,
          fileCount: Array.isArray((driveData as Record<string, unknown>)?.files)
            ? ((driveData as Record<string, unknown>).files as unknown[]).length
            : 0,
        });
      } catch (error) {
        this.logger.warn('Drive sync skipped - insufficient permissions or not available', {
          connectionId: payload.connectionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // Update connection sync state with new sync tokens/history IDs
      this.logger.log('Updating connection sync state', {
        connectionId: payload.connectionId,
        results: syncResults.map((r) => ({
          api: r.api,
          hasSyncState: !!r.syncState,
          syncStateKeys: r.syncState ? Object.keys(r.syncState) : [],
        })),
      });

      await this.updateConnectionSyncState(payload.connectionId, syncResults);

      // Log the sync result
      this.logger.log('Google sync completed', {
        connectionId: payload.connectionId,
        userId: payload.userId,
        success: errors.length === 0,
        message: `Sync completed. ${syncResults.length} APIs processed successfully. ${errors.length} errors occurred.`,
      });

      // Process the API logs to create structured events
      if (errors.length === 0) {
        try {
          this.logger.log('Processing API logs to create structured events', {
            connectionId: payload.connectionId,
          });
          await this.eventProcessorService.processConnectionLogs(payload.connectionId);
        } catch (error) {
          this.logger.error('Failed to process API logs into events', {
            connectionId: payload.connectionId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    } catch (error) {
      this.logger.error('Error during Google data sync', error as Error);
    }
  }

  private async syncCalendarWithPagination(
    connection: { id: string; syncState: Record<string, unknown> | null },
    userId: string,
  ): Promise<{ api: string; syncState: Record<string, unknown> | null }> {
    const { SyncStateHelper } = await import('@ci/domains/connections/types/sync-state');
    const calendarSyncState = SyncStateHelper.getCalendarSyncState(connection.syncState);

    this.logger.log('Starting Calendar sync with pagination', {
      connectionId: connection.id,
      hasSyncState: !!connection.syncState,
      calendarSyncState,
      syncToken: calendarSyncState?.syncToken,
    });

    let newSyncState: Record<string, unknown> | null = null;
    let totalEvents = 0;
    let pageCount = 0;

    if (calendarSyncState?.syncToken) {
      // Incremental sync using syncToken
      this.logger.log('Performing incremental calendar sync', {
        connectionId: connection.id,
        syncToken: calendarSyncState.syncToken,
      });

      try {
        const response = (await this.connectionService.makePaginatedRequest(
          connection.id,
          `/calendar/v3/calendars/primary/events?syncToken=${calendarSyncState.syncToken}&showDeleted=true`,
        )) as Record<string, unknown>;

        const events = (response.items as unknown[]) || [];
        totalEvents = events.length;

        // Save this page of incremental data only if there are new events
        if (events.length > 0) {
          await this.apiLogService.create({
            content: { items: events, nextSyncToken: response.nextSyncToken },
            userId,
            connectionId: connection.id,
            scope: 'Google Calendar',
          });

          this.logger.log('Saved incremental calendar data', {
            connectionId: connection.id,
            eventCount: events.length,
            syncToken: response.nextSyncToken,
          });
        } else {
          this.logger.log('No new calendar events found in incremental sync', {
            connectionId: connection.id,
            syncToken: response.nextSyncToken,
          });
        }

        newSyncState = {
          syncToken: response.nextSyncToken as string,
          lastFullSyncAt: calendarSyncState.lastFullSyncAt,
          lastUpdatedMinUsed: calendarSyncState.lastUpdatedMinUsed,
        };

        this.logger.log('Calendar incremental sync completed', {
          connectionId: connection.id,
          eventCount: totalEvents,
          syncToken: newSyncState.syncToken,
        });

        return { api: 'Google Calendar', syncState: newSyncState };
      } catch (error) {
        // If we get 410 Gone, the syncToken is stale - do a fresh full sync
        if (error instanceof Error && error.message.includes('410')) {
          this.logger.warn('Calendar syncToken is stale, performing fresh full sync', {
            connectionId: connection.id,
            oldSyncToken: calendarSyncState.syncToken,
          });
          // Fall through to full sync
        } else {
          throw error;
        }
      }
    }

    // Full sync - bootstrap (either first time or after stale token)
    this.logger.log('Performing full calendar sync with pagination', {
      connectionId: connection.id,
    });

    const now = new Date();
    const timeMin = new Date(now.getTime() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString(); // 10 years ago
    const timeMax = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(); // 10 years from now
    let nextPageToken: string | undefined;
    let finalSyncToken: string | undefined;

    do {
      let endpoint = `/calendar/v3/calendars/primary/events?maxResults=2500&timeMin=${timeMin}&timeMax=${timeMax}&showDeleted=true&singleEvents=true`;
      if (nextPageToken) {
        endpoint += `&pageToken=${nextPageToken}`;
      }

      const response = (await this.connectionService.makePaginatedRequest(connection.id, endpoint)) as Record<
        string,
        unknown
      >;
      const events = (response.items as unknown[]) || [];

      totalEvents += events.length;
      pageCount++;
      nextPageToken = response.nextPageToken as string | undefined;
      finalSyncToken = response.nextSyncToken as string | undefined; // Capture syncToken from each response

      // Save each page as a separate API log entry
      if (events.length > 0) {
        await this.apiLogService.create({
          content: { items: events, nextPageToken: response.nextPageToken },
          userId,
          connectionId: connection.id,
          scope: 'Google Calendar',
        });

        this.logger.log('Saved calendar page', {
          connectionId: connection.id,
          page: pageCount,
          eventCount: events.length,
          totalEvents,
          hasNextPage: !!nextPageToken,
          hasSyncToken: !!response.nextSyncToken,
          syncToken: response.nextSyncToken,
        });
      }
    } while (nextPageToken);

    // If we didn't get a syncToken from the paginated requests, try to get one
    if (!finalSyncToken) {
      this.logger.log('No syncToken from paginated requests, attempting to get one', {
        connectionId: connection.id,
      });

      const finalResponse = (await this.connectionService.makePaginatedRequest(
        connection.id,
        `/calendar/v3/calendars/primary/events?maxResults=1&showDeleted=true&singleEvents=true`,
      )) as Record<string, unknown>;

      finalSyncToken = finalResponse.nextSyncToken as string | undefined;

      this.logger.log('Final response for syncToken', {
        connectionId: connection.id,
        finalResponse,
        nextSyncToken: finalResponse.nextSyncToken,
        hasNextSyncToken: !!finalResponse.nextSyncToken,
        responseKeys: Object.keys(finalResponse),
        hasNextPageToken: !!finalResponse.nextPageToken,
        nextPageToken: finalResponse.nextPageToken,
      });
    }

    // Check if we got a syncToken from the API
    if (!finalSyncToken) {
      this.logger.warn('No nextSyncToken returned from Google Calendar API', {
        connectionId: connection.id,
        finalSyncToken,
      });
      // If no syncToken, we'll do full sync next time
      newSyncState = {
        lastFullSyncAt: new Date().toISOString(),
        lastUpdatedMinUsed: timeMin,
      };
    } else {
      newSyncState = {
        syncToken: finalSyncToken,
        lastFullSyncAt: new Date().toISOString(),
        lastUpdatedMinUsed: timeMin,
      };
    }

    this.logger.log('Calendar full sync completed', {
      connectionId: connection.id,
      totalEventCount: totalEvents,
      pageCount,
      syncToken: newSyncState.syncToken,
    });

    return { api: 'Google Calendar', syncState: newSyncState };
  }

  private async syncGmailWithPagination(
    connection: { id: string; syncState: Record<string, unknown> | null },
    userId: string,
  ): Promise<{ api: string; syncState: Record<string, unknown> | null }> {
    const { SyncStateHelper } = await import('@ci/domains/connections/types/sync-state');
    const gmailSyncState = SyncStateHelper.getGmailSyncState(connection.syncState);

    this.logger.log('Starting Gmail sync with pagination', {
      connectionId: connection.id,
      hasSyncState: !!connection.syncState,
      gmailSyncState,
      lastHistoryId: gmailSyncState?.lastHistoryId,
    });

    let newSyncState: Record<string, unknown> | null = null;
    let totalMessages = 0;
    let pageCount = 0;

    if (gmailSyncState?.lastHistoryId) {
      // Incremental sync using historyId
      this.logger.log('Performing incremental Gmail sync', {
        connectionId: connection.id,
        lastHistoryId: gmailSyncState.lastHistoryId,
      });

      try {
        const response = (await this.connectionService.makePaginatedRequest(
          connection.id,
          `/gmail/v1/users/me/history?startHistoryId=${gmailSyncState.lastHistoryId}`,
        )) as Record<string, unknown>;

        const history = (response.history as unknown[]) || [];
        totalMessages = history.length;

        // Get the latest historyId from the response for the next sync
        const latestHistoryId = response.historyId as string;

        // Save this page of incremental data only if there are new messages
        if (history.length > 0) {
          await this.apiLogService.create({
            content: { history },
            userId,
            connectionId: connection.id,
            scope: 'Gmail',
          });

          this.logger.log('Saved incremental Gmail data', {
            connectionId: connection.id,
            historyCount: history.length,
            lastHistoryId: gmailSyncState.lastHistoryId,
            latestHistoryId: latestHistoryId,
          });
        } else {
          this.logger.log('No new Gmail messages found in incremental sync', {
            connectionId: connection.id,
            lastHistoryId: gmailSyncState.lastHistoryId,
            latestHistoryId: latestHistoryId,
          });
        }

        newSyncState = {
          lastHistoryId: latestHistoryId || gmailSyncState.lastHistoryId, // Use latest historyId or fallback to current
          trackedLabels: gmailSyncState.trackedLabels || ['INBOX'],
          watchChannelId: gmailSyncState.watchChannelId,
          watchResourceId: gmailSyncState.watchResourceId,
          watchExpiration: gmailSyncState.watchExpiration,
        };

        this.logger.log('Gmail incremental sync completed', {
          connectionId: connection.id,
          historyCount: totalMessages,
          lastHistoryId: newSyncState.lastHistoryId,
        });

        return { api: 'Gmail', syncState: newSyncState };
      } catch (error) {
        // If we get historyIdOutOfRange, do a fresh baseline
        if (error instanceof Error && error.message.includes('historyIdOutOfRange')) {
          this.logger.warn('Gmail historyId is out of range, performing fresh baseline', {
            connectionId: connection.id,
            oldHistoryId: gmailSyncState.lastHistoryId,
          });
          // Fall through to full sync
        } else {
          throw error;
        }
      }
    }

    // Full sync - get all messages and establish historyId
    this.logger.log('Performing full Gmail sync with pagination', { connectionId: connection.id });

    const labels = gmailSyncState?.trackedLabels || ['INBOX'];
    let nextPageToken: string | undefined;

    // Get all message IDs first
    do {
      let endpoint = `/gmail/v1/users/me/messages?maxResults=500&labelIds=${labels.join(',')}`;
      if (nextPageToken) {
        endpoint += `&pageToken=${nextPageToken}`;
      }

      const response = (await this.connectionService.makePaginatedRequest(connection.id, endpoint)) as Record<
        string,
        unknown
      >;
      const messages = (response.messages as unknown[]) || [];

      totalMessages += messages.length;
      pageCount++;
      nextPageToken = response.nextPageToken as string | undefined;

      // Save each page as a separate API log entry
      if (messages.length > 0) {
        await this.apiLogService.create({
          content: { messages, nextPageToken: response.nextPageToken },
          userId,
          connectionId: connection.id,
          scope: 'Gmail',
        });

        this.logger.log('Saved Gmail page', {
          connectionId: connection.id,
          page: pageCount,
          messageCount: messages.length,
          totalMessages,
          hasNextPage: !!nextPageToken,
        });
      }
    } while (nextPageToken);

    // Get current historyId from profile for future incremental syncs
    const profile = (await this.connectionService.makePaginatedRequest(
      connection.id,
      '/gmail/v1/users/me/profile',
    )) as Record<string, unknown>;

    newSyncState = {
      lastHistoryId: profile.historyId as string,
      trackedLabels: labels,
    };

    this.logger.log('Gmail full sync completed', {
      connectionId: connection.id,
      totalMessageCount: totalMessages,
      pageCount,
      historyId: newSyncState.lastHistoryId,
    });

    return { api: 'Gmail', syncState: newSyncState };
  }

  private shouldSyncConnection(connection: {
    id: string;
    schedule: string | null;
    active: boolean;
    syncState: Record<string, unknown> | null;
  }): boolean {
    // Check if connection is active and has a schedule
    if (!connection.active || !connection.schedule) {
      return false;
    }

    // If no sync state exists, this is the first sync - always sync
    if (!connection.syncState) {
      this.logger.log('First sync detected - no sync state found', {
        connectionId: connection.id,
      });

      return true;
    }

    // Check if we have sync state for any API - if not, do full sync
    const hasCalendarState = !!connection.syncState.calendar;
    const hasGmailState = !!connection.syncState.gmail;

    if (!hasCalendarState && !hasGmailState) {
      this.logger.log('No API sync state found - performing full sync', {
        connectionId: connection.id,
      });

      return true;
    }

    // For incremental sync, check if enough time has passed since last sync
    // Parse the schedule to determine sync frequency
    const scheduleMinutes = this.parseScheduleToMinutes(connection.schedule);
    if (scheduleMinutes === null) {
      this.logger.warn('Invalid schedule format, defaulting to 5 minutes', {
        connectionId: connection.id,
        schedule: connection.schedule,
      });

      return true; // Default to sync every 5 minutes
    }

    // Check if enough time has passed since last sync
    const lastSyncTime = this.getLastSyncTime(connection.syncState);
    const now = new Date();
    const timeSinceLastSync = now.getTime() - lastSyncTime.getTime();
    const minutesSinceLastSync = timeSinceLastSync / (1000 * 60);

    const shouldSync = minutesSinceLastSync >= scheduleMinutes;

    this.logger.log('Sync decision', {
      connectionId: connection.id,
      hasCalendarState,
      hasGmailState,
      scheduleMinutes,
      minutesSinceLastSync: Math.round(minutesSinceLastSync * 100) / 100,
      shouldSync,
    });

    return shouldSync;
  }

  private parseScheduleToMinutes(schedule: string | null): number | null {
    if (!schedule) {
      return null;
    }

    // Parse schedule formats like "5m", "1h", "30s", etc.
    const match = schedule.match(/^(\d+)([smhd])$/);
    if (!match) {
      return null;
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value / 60; // seconds to minutes
      case 'm':
        return value; // minutes
      case 'h':
        return value * 60; // hours to minutes
      case 'd':
        return value * 60 * 24; // days to minutes
      default:
        return null;
    }
  }

  private getLastSyncTime(syncState: Record<string, unknown> | null): Date {
    if (!syncState) {
      return new Date(0);
    } // Very old date if no sync state

    // Get the most recent sync time from any API
    let lastSyncTime = new Date(0);

    if (syncState.calendar && typeof syncState.calendar === 'object') {
      const calendar = syncState.calendar as Record<string, unknown>;
      if (calendar.lastFullSyncAt) {
        const calendarTime = new Date(calendar.lastFullSyncAt as string);
        if (calendarTime > lastSyncTime) {
          lastSyncTime = calendarTime;
        }
      }
    }

    if (syncState.gmail && typeof syncState.gmail === 'object') {
      const gmail = syncState.gmail as Record<string, unknown>;
      if (gmail.lastFullSyncAt) {
        const gmailTime = new Date(gmail.lastFullSyncAt as string);
        if (gmailTime > lastSyncTime) {
          lastSyncTime = gmailTime;
        }
      }
    }

    return lastSyncTime;
  }

  private async updateConnectionSyncState(
    connectionId: string,
    results: Array<{ api: string; syncState: Record<string, unknown> | null }>,
  ): Promise<void> {
    try {
      // Get current connection
      const connection = await this.connectionService.findById(connectionId);
      if (!connection) {
        this.logger.warn('Connection not found for sync state update', { connectionId });

        return;
      }

      let updatedSyncState = { ...connection.syncState } as Record<string, unknown>;

      // Update sync state for each API result
      for (const result of results) {
        if (result.syncState) {
          if (result.api.toLowerCase().includes('calendar')) {
            this.logger.log('Updating calendar sync state with data', {
              connectionId,
              resultSyncState: result.syncState,
              syncToken: (result.syncState as Record<string, unknown>).syncToken,
              lastFullSyncAt: (result.syncState as Record<string, unknown>).lastFullSyncAt,
            });
            updatedSyncState = SyncStateHelper.updateCalendarSyncState(updatedSyncState, result.syncState);
            this.logger.log('Updated calendar sync state', {
              connectionId,
              syncToken: (result.syncState as Record<string, unknown>).syncToken,
              lastFullSyncAt: (result.syncState as Record<string, unknown>).lastFullSyncAt,
            });
          } else if (result.api.toLowerCase().includes('gmail')) {
            updatedSyncState = SyncStateHelper.updateGmailSyncState(updatedSyncState, result.syncState);
            this.logger.log('Updated Gmail sync state', {
              connectionId,
              lastHistoryId: (result.syncState as Record<string, unknown>).lastHistoryId,
              trackedLabels: (result.syncState as Record<string, unknown>).trackedLabels,
            });
          }
        }
      }

      // Update the connection with new sync state
      this.logger.log('About to save sync state', {
        connectionId,
        updatedSyncState,
        calendarSyncState: updatedSyncState.calendar,
        syncToken: (updatedSyncState.calendar as Record<string, unknown>)?.syncToken,
      });
      await this.connectionService.updateSyncState(connectionId, updatedSyncState);

      // Verify the sync state was actually saved by fetching the connection again
      const updatedConnection = await this.connectionService.findById(connectionId);
      this.logger.log('Connection sync state updated and verified', {
        connectionId,
        hasCalendarState: !!updatedSyncState.calendar,
        hasGmailState: !!updatedSyncState.gmail,
        fullUpdatedSyncState: updatedSyncState,
        verifiedSyncState: updatedConnection?.syncState,
        verifiedSyncStateString: JSON.stringify(updatedConnection?.syncState),
      });
    } catch (error) {
      this.logger.error('Failed to update connection sync state', {
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
