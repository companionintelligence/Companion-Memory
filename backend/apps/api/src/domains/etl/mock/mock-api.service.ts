import { Injectable } from '@nestjs/common';
import {
  generateDiscordMessages,
  generateDiscordDMChannels,
  generateDiscordGuilds,
  generateSlackMessages,
  generateSlackChannels,
  generateSlackFiles,
  generateGitHubRepos,
  generateGitHubStarredRepos,
  generateGitHubIssues,
  generateGitHubPullRequests,
  generateGitHubEvents,
  generateTwitterTweets,
  generateTwitterLikedTweets,
  generateLinkedInPosts,
  generateLinkedInConnections,
  generateSpotifyPlaylists,
  generateSpotifyPlaylistTracks,
  generateSpotifySavedTracks,
  generateSpotifyRecentlyPlayed,
  generateInstagramMedia,
  generateTwitchVideos,
  generateTwitchFollows,
  generateTwitchClips,
  generateRedditPosts,
  generateRedditComments,
  generateRedditSaved,
  generateSteamGames,
  generateSteamAchievements,
  generateSteamRecentGames,
  generateNotionPages,
  generateNotionPageContent,
  generateNotionDatabaseQuery,
  generateDropboxFiles,
  generateDropboxFilesContinue,
  generateBoxFiles,
  generateBoxFileInfo,
  generateNextcloudFiles,
  generateNextcloudContacts,
  generateNextcloudCalendar,
  generateShopifyOrders,
  generateShopifyProducts,
  generateShopifyCustomers,
  generateStripeCharges,
  generateStripePaymentIntents,
  generateStripeCustomers,
  generateStripeSubscriptions,
  generateTrelloBoards,
  generateTrelloCards,
  generateAsanaTasks,
  generateAsanaProjects,
  generateZoomMeetings,
  generateZoomRecordings,
  generateTelegramUpdates,
  generateTelegramMessages,
  generateSignalMessages,
  generateOpenAIConversations,
  generateOpenAIModels,
  generateAnthropicMessages,
} from './mock-data-generators';

@Injectable()
export class MockApiService {
  // Discord
  generateDiscordMessages(channelId: string, query: any) {
    return generateDiscordMessages(channelId, query);
  }

  generateDiscordDMChannels() {
    return generateDiscordDMChannels();
  }

  generateDiscordGuilds(query: any) {
    return generateDiscordGuilds(query);
  }

  // Slack
  generateSlackMessages(query: any) {
    return generateSlackMessages(query);
  }

  generateSlackChannels(query: any) {
    return generateSlackChannels(query);
  }

  generateSlackFiles(query: any) {
    return generateSlackFiles(query);
  }

  // GitHub
  generateGitHubRepos(query: any) {
    return generateGitHubRepos(query);
  }

  generateGitHubStarredRepos(query: any) {
    return generateGitHubStarredRepos(query);
  }

  generateGitHubIssues(query: any) {
    return generateGitHubIssues(query);
  }

  generateGitHubPullRequests(query: any) {
    return generateGitHubPullRequests(query);
  }

  generateGitHubEvents(username: string, query: any) {
    return generateGitHubEvents(username, query);
  }

  // Twitter
  generateTwitterTweets(userId: string, query: any) {
    return generateTwitterTweets(userId, query);
  }

  generateTwitterLikedTweets(userId: string, query: any) {
    return generateTwitterLikedTweets(userId, query);
  }

  // LinkedIn
  generateLinkedInPosts(query: any) {
    return generateLinkedInPosts(query);
  }

  generateLinkedInConnections(query: any) {
    return generateLinkedInConnections(query);
  }

  // Spotify
  generateSpotifyPlaylists(query: any) {
    return generateSpotifyPlaylists(query);
  }

  generateSpotifyPlaylistTracks(playlistId: string, query: any) {
    return generateSpotifyPlaylistTracks(playlistId, query);
  }

  generateSpotifySavedTracks(query: any) {
    return generateSpotifySavedTracks(query);
  }

  generateSpotifyRecentlyPlayed(query: any) {
    return generateSpotifyRecentlyPlayed(query);
  }

  // Instagram
  generateInstagramMedia(query: any) {
    return generateInstagramMedia(query);
  }

  // Twitch
  generateTwitchVideos(query: any) {
    return generateTwitchVideos(query);
  }

  generateTwitchFollows(query: any) {
    return generateTwitchFollows(query);
  }

  generateTwitchClips(query: any) {
    return generateTwitchClips(query);
  }

  // Reddit
  generateRedditPosts(username: string, query: any) {
    return generateRedditPosts(username, query);
  }

  generateRedditComments(username: string, query: any) {
    return generateRedditComments(username, query);
  }

  generateRedditSaved(username: string, query: any) {
    return generateRedditSaved(username, query);
  }

  // Steam
  generateSteamGames(query: any) {
    return generateSteamGames(query);
  }

  generateSteamAchievements(query: any) {
    return generateSteamAchievements(query);
  }

  generateSteamRecentGames(query: any) {
    return generateSteamRecentGames(query);
  }

  // Notion
  generateNotionPages(query: any) {
    return generateNotionPages(query);
  }

  generateNotionPageContent(pageId: string) {
    return generateNotionPageContent(pageId);
  }

  generateNotionDatabaseQuery(databaseId: string, query: any) {
    return generateNotionDatabaseQuery(databaseId, query);
  }

  // Dropbox
  generateDropboxFiles(query: any) {
    return generateDropboxFiles(query);
  }

  generateDropboxFilesContinue(query: any) {
    return generateDropboxFilesContinue(query);
  }

  // Box
  generateBoxFiles(folderId: string, query: any) {
    return generateBoxFiles(folderId, query);
  }

  generateBoxFileInfo(fileId: string) {
    return generateBoxFileInfo(fileId);
  }

  // Nextcloud
  generateNextcloudFiles(userId: string) {
    return generateNextcloudFiles(userId);
  }

  generateNextcloudContacts(userId: string) {
    return generateNextcloudContacts(userId);
  }

  generateNextcloudCalendar(userId: string) {
    return generateNextcloudCalendar(userId);
  }

  // Shopify
  generateShopifyOrders(query: any) {
    return generateShopifyOrders(query);
  }

  generateShopifyProducts(query: any) {
    return generateShopifyProducts(query);
  }

  generateShopifyCustomers(query: any) {
    return generateShopifyCustomers(query);
  }

  // Stripe
  generateStripeCharges(query: any) {
    return generateStripeCharges(query);
  }

  generateStripePaymentIntents(query: any) {
    return generateStripePaymentIntents(query);
  }

  generateStripeCustomers(query: any) {
    return generateStripeCustomers(query);
  }

  generateStripeSubscriptions(query: any) {
    return generateStripeSubscriptions(query);
  }

  // Trello
  generateTrelloBoards(query: any) {
    return generateTrelloBoards(query);
  }

  generateTrelloCards(query: any) {
    return generateTrelloCards(query);
  }

  // Asana
  generateAsanaTasks(userTaskListGid: string, query: any) {
    return generateAsanaTasks(userTaskListGid, query);
  }

  generateAsanaProjects(query: any) {
    return generateAsanaProjects(query);
  }

  // Zoom
  generateZoomMeetings(query: any) {
    return generateZoomMeetings(query);
  }

  generateZoomRecordings(query: any) {
    return generateZoomRecordings(query);
  }

  // Telegram
  generateTelegramUpdates(query: any) {
    return generateTelegramUpdates(query);
  }

  generateTelegramMessages(query: any) {
    return generateTelegramMessages(query);
  }

  // Signal
  generateSignalMessages(query: any) {
    return generateSignalMessages(query);
  }

  // OpenAI
  generateOpenAIConversations(query: any) {
    return generateOpenAIConversations(query);
  }

  generateOpenAIModels() {
    return generateOpenAIModels();
  }

  // Anthropic
  generateAnthropicMessages(query: any) {
    return generateAnthropicMessages(query);
  }
}
