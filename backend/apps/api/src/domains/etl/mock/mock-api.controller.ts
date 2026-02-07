import { Controller, Get, Post, Param, Query, Headers, HttpException, HttpStatus } from '@nestjs/common';
import { MockApiService } from './mock-api.service';

@Controller('mock')
export class MockApiController {
  constructor(private readonly mockApiService: MockApiService) {}

  // Discord endpoints
  @Get('discord/channels/:channelId/messages')
  getDiscordMessages(@Param('channelId') channelId: string, @Query() query: any) {
    return this.mockApiService.generateDiscordMessages(channelId, query);
  }

  @Get('discord/users/@me/channels')
  getDiscordDMChannels() {
    return this.mockApiService.generateDiscordDMChannels();
  }

  @Get('discord/users/@me/guilds')
  getDiscordGuilds(@Query() query: any) {
    return this.mockApiService.generateDiscordGuilds(query);
  }

  // Slack endpoints
  @Get('slack/conversations.history')
  getSlackConversationHistory(@Query() query: any) {
    return this.mockApiService.generateSlackMessages(query);
  }

  @Get('slack/conversations.list')
  getSlackConversationsList(@Query() query: any) {
    return this.mockApiService.generateSlackChannels(query);
  }

  @Get('slack/files.list')
  getSlackFilesList(@Query() query: any) {
    return this.mockApiService.generateSlackFiles(query);
  }

  // GitHub endpoints
  @Get('github/user/repos')
  getGitHubRepos(@Query() query: any) {
    return this.mockApiService.generateGitHubRepos(query);
  }

  @Get('github/user/starred')
  getGitHubStarred(@Query() query: any) {
    return this.mockApiService.generateGitHubStarredRepos(query);
  }

  @Get('github/user/issues')
  getGitHubIssues(@Query() query: any) {
    return this.mockApiService.generateGitHubIssues(query);
  }

  @Get('github/search/issues')
  searchGitHubPullRequests(@Query() query: any) {
    return this.mockApiService.generateGitHubPullRequests(query);
  }

  @Get('github/users/:username/events')
  getGitHubEvents(@Param('username') username: string, @Query() query: any) {
    return this.mockApiService.generateGitHubEvents(username, query);
  }

  // Twitter endpoints
  @Get('twitter/users/:userId/tweets')
  getTwitterTweets(@Param('userId') userId: string, @Query() query: any) {
    return this.mockApiService.generateTwitterTweets(userId, query);
  }

  @Get('twitter/users/:userId/liked_tweets')
  getTwitterLikedTweets(@Param('userId') userId: string, @Query() query: any) {
    return this.mockApiService.generateTwitterLikedTweets(userId, query);
  }

  // LinkedIn endpoints
  @Get('linkedin/ugcPosts')
  getLinkedInPosts(@Query() query: any) {
    return this.mockApiService.generateLinkedInPosts(query);
  }

  @Get('linkedin/connections')
  getLinkedInConnections(@Query() query: any) {
    return this.mockApiService.generateLinkedInConnections(query);
  }

  // Spotify endpoints
  @Get('spotify/me/playlists')
  getSpotifyPlaylists(@Query() query: any) {
    return this.mockApiService.generateSpotifyPlaylists(query);
  }

  @Get('spotify/playlists/:playlistId/tracks')
  getSpotifyPlaylistTracks(@Param('playlistId') playlistId: string, @Query() query: any) {
    return this.mockApiService.generateSpotifyPlaylistTracks(playlistId, query);
  }

  @Get('spotify/me/tracks')
  getSpotifyUserSavedTracks(@Query() query: any) {
    return this.mockApiService.generateSpotifySavedTracks(query);
  }

  @Get('spotify/me/player/recently-played')
  getSpotifyRecentlyPlayed(@Query() query: any) {
    return this.mockApiService.generateSpotifyRecentlyPlayed(query);
  }

  // Instagram endpoints
  @Get('instagram/me/media')
  getInstagramMedia(@Query() query: any) {
    return this.mockApiService.generateInstagramMedia(query);
  }

  // Twitch endpoints
  @Get('twitch/videos')
  getTwitchVideos(@Query() query: any) {
    return this.mockApiService.generateTwitchVideos(query);
  }

  @Get('twitch/users/follows')
  getTwitchFollows(@Query() query: any) {
    return this.mockApiService.generateTwitchFollows(query);
  }

  @Get('twitch/clips')
  getTwitchClips(@Query() query: any) {
    return this.mockApiService.generateTwitchClips(query);
  }

  // Reddit endpoints
  @Get('reddit/user/:username/submitted')
  getRedditSubmitted(@Param('username') username: string, @Query() query: any) {
    return this.mockApiService.generateRedditPosts(username, query);
  }

  @Get('reddit/user/:username/comments')
  getRedditComments(@Param('username') username: string, @Query() query: any) {
    return this.mockApiService.generateRedditComments(username, query);
  }

  @Get('reddit/user/:username/saved')
  getRedditSaved(@Param('username') username: string, @Query() query: any) {
    return this.mockApiService.generateRedditSaved(username, query);
  }

  // Steam endpoints
  @Get('steam/IPlayerService/GetOwnedGames/v1')
  getSteamOwnedGames(@Query() query: any) {
    return this.mockApiService.generateSteamGames(query);
  }

  @Get('steam/ISteamUserStats/GetPlayerAchievements/v1')
  getSteamAchievements(@Query() query: any) {
    return this.mockApiService.generateSteamAchievements(query);
  }

  @Get('steam/IPlayerService/GetRecentlyPlayedGames/v1')
  getSteamRecentGames(@Query() query: any) {
    return this.mockApiService.generateSteamRecentGames(query);
  }

  // Notion endpoints
  @Post('notion/search')
  notionSearch(@Query() query: any) {
    return this.mockApiService.generateNotionPages(query);
  }

  @Get('notion/pages/:pageId')
  getNotionPage(@Param('pageId') pageId: string) {
    return this.mockApiService.generateNotionPageContent(pageId);
  }

  @Post('notion/databases/:databaseId/query')
  notionDatabaseQuery(@Param('databaseId') databaseId: string, @Query() query: any) {
    return this.mockApiService.generateNotionDatabaseQuery(databaseId, query);
  }

  // Dropbox endpoints
  @Post('dropbox/files/list_folder')
  dropboxListFolder(@Query() query: any) {
    return this.mockApiService.generateDropboxFiles(query);
  }

  @Post('dropbox/files/list_folder/continue')
  dropboxListFolderContinue(@Query() query: any) {
    return this.mockApiService.generateDropboxFilesContinue(query);
  }

  // Box endpoints
  @Get('box/folders/:folderId/items')
  getBoxFolderItems(@Param('folderId') folderId: string, @Query() query: any) {
    return this.mockApiService.generateBoxFiles(folderId, query);
  }

  @Get('box/files/:fileId')
  getBoxFileInfo(@Param('fileId') fileId: string) {
    return this.mockApiService.generateBoxFileInfo(fileId);
  }

  // Nextcloud endpoints
  @Get('nextcloud/remote.php/dav/files/:userId')
  nextcloudWebDAVList(@Param('userId') userId: string) {
    return this.mockApiService.generateNextcloudFiles(userId);
  }

  @Get('nextcloud/remote.php/dav/addressbooks/users/:userId/contacts')
  nextcloudCardDAVContacts(@Param('userId') userId: string) {
    return this.mockApiService.generateNextcloudContacts(userId);
  }

  @Get('nextcloud/remote.php/dav/calendars/:userId/personal')
  nextcloudCalDAVEvents(@Param('userId') userId: string) {
    return this.mockApiService.generateNextcloudCalendar(userId);
  }

  // Shopify endpoints
  @Get('shopify/admin/api/2024-01/orders.json')
  getShopifyOrders(@Query() query: any) {
    return this.mockApiService.generateShopifyOrders(query);
  }

  @Get('shopify/admin/api/2024-01/products.json')
  getShopifyProducts(@Query() query: any) {
    return this.mockApiService.generateShopifyProducts(query);
  }

  @Get('shopify/admin/api/2024-01/customers.json')
  getShopifyCustomers(@Query() query: any) {
    return this.mockApiService.generateShopifyCustomers(query);
  }

  // Stripe endpoints
  @Get('stripe/v1/charges')
  getStripeCharges(@Query() query: any) {
    return this.mockApiService.generateStripeCharges(query);
  }

  @Get('stripe/v1/payment_intents')
  getStripePaymentIntents(@Query() query: any) {
    return this.mockApiService.generateStripePaymentIntents(query);
  }

  @Get('stripe/v1/customers')
  getStripeCustomers(@Query() query: any) {
    return this.mockApiService.generateStripeCustomers(query);
  }

  @Get('stripe/v1/subscriptions')
  getStripeSubscriptions(@Query() query: any) {
    return this.mockApiService.generateStripeSubscriptions(query);
  }

  // Trello endpoints
  @Get('trello/members/me/boards')
  getTrelloBoards(@Query() query: any) {
    return this.mockApiService.generateTrelloBoards(query);
  }

  @Get('trello/members/me/cards')
  getTrelloCards(@Query() query: any) {
    return this.mockApiService.generateTrelloCards(query);
  }

  // Asana endpoints
  @Get('asana/user_task_lists/:userTaskListGid/tasks')
  getAsanaTasks(@Param('userTaskListGid') userTaskListGid: string, @Query() query: any) {
    return this.mockApiService.generateAsanaTasks(userTaskListGid, query);
  }

  @Get('asana/projects')
  getAsanaProjects(@Query() query: any) {
    return this.mockApiService.generateAsanaProjects(query);
  }

  // Zoom endpoints
  @Get('zoom/users/me/meetings')
  getZoomMeetings(@Query() query: any) {
    return this.mockApiService.generateZoomMeetings(query);
  }

  @Get('zoom/users/me/recordings')
  getZoomRecordings(@Query() query: any) {
    return this.mockApiService.generateZoomRecordings(query);
  }

  // Telegram endpoints
  @Get('telegram/getUpdates')
  getTelegramUpdates(@Query() query: any) {
    return this.mockApiService.generateTelegramUpdates(query);
  }

  @Get('telegram/getMessages')
  getTelegramMessages(@Query() query: any) {
    return this.mockApiService.generateTelegramMessages(query);
  }

  // Signal endpoints
  @Get('signal/v1/receive')
  getSignalMessages(@Query() query: any) {
    return this.mockApiService.generateSignalMessages(query);
  }

  // OpenAI endpoints
  @Get('openai/v1/chat/conversations')
  getOpenAIConversations(@Query() query: any) {
    return this.mockApiService.generateOpenAIConversations(query);
  }

  @Get('openai/v1/models')
  getOpenAIModels() {
    return this.mockApiService.generateOpenAIModels();
  }

  // Anthropic endpoints
  @Get('anthropic/v1/messages')
  getAnthropicMessages(@Query() query: any) {
    return this.mockApiService.generateAnthropicMessages(query);
  }
}
