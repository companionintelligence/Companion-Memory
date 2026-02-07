// Utility functions for generating mock data
function randomId(length = 16): string {
  return Math.random().toString(36).substring(2, length + 2).padEnd(length, '0');
}

function randomDate(daysBack = 30): string {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(Math.random() * daysBack));
  return date.toISOString();
}

function randomName(): string {
  const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Jack'];
  return names[Math.floor(Math.random() * names.length)];
}

function randomEmail(): string {
  return `${randomName().toLowerCase()}${Math.floor(Math.random() * 1000)}@example.com`;
}

function randomUrl(): string {
  return `https://example.com/${randomId(8)}`;
}

function generatePaginationResponse(data: any[], limit: number, cursorField?: string) {
  const hasMore = data.length >= limit;
  const nextCursor = hasMore ? randomId() : null;
  return {
    data,
    pagination: cursorField
      ? { [cursorField]: nextCursor }
      : { next_cursor: nextCursor, has_more: hasMore },
  };
}

// Discord generators
export function generateDiscordMessages(channelId: string, query: any) {
  const limit = parseInt(query.limit || '100');
  const messages = Array.from({ length: Math.min(limit, 50) }, (_, i) => ({
    id: randomId(18),
    channel_id: channelId,
    author: {
      id: randomId(18),
      username: randomName(),
      discriminator: `${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
      avatar: randomId(32),
    },
    content: `This is a test message ${i + 1}`,
    timestamp: randomDate(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    attachments: [],
    embeds: [],
    reactions: [],
  }));

  return { messages };
}

export function generateDiscordDMChannels() {
  const channels = Array.from({ length: 10 }, (_, i) => ({
    id: randomId(18),
    type: 1,
    recipients: [
      {
        id: randomId(18),
        username: randomName(),
        discriminator: `${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
        avatar: randomId(32),
      },
    ],
    last_message_id: randomId(18),
  }));

  return { channels };
}

export function generateDiscordGuilds(query: any) {
  const limit = parseInt(query.limit || '200');
  const guilds = Array.from({ length: Math.min(limit, 20) }, (_, i) => ({
    id: randomId(18),
    name: `Server ${i + 1}`,
    icon: randomId(32),
    owner: false,
    permissions: '2147483647',
    features: [],
  }));

  return { guilds };
}

// Slack generators
export function generateSlackMessages(query: any) {
  const limit = parseInt(query.limit || '100');
  const messages = Array.from({ length: Math.min(limit, 50) }, (_, i) => ({
    type: 'message',
    user: randomId(9),
    text: `This is a test message ${i + 1}`,
    ts: (Date.now() / 1000 - i * 3600).toString(),
  }));

  return {
    ok: true,
    messages,
    has_more: messages.length >= limit,
    response_metadata: {
      next_cursor: messages.length >= limit ? randomId() : '',
    },
  };
}

export function generateSlackChannels(query: any) {
  const channels = Array.from({ length: 20 }, (_, i) => ({
    id: randomId(9),
    name: `channel-${i + 1}`,
    is_channel: true,
    is_group: false,
    is_im: false,
    created: Math.floor(Date.now() / 1000) - 86400 * 30,
    is_archived: false,
    is_general: i === 0,
    is_member: true,
    num_members: Math.floor(Math.random() * 100),
  }));

  return { ok: true, channels };
}

export function generateSlackFiles(query: any) {
  const files = Array.from({ length: 20 }, (_, i) => ({
    id: randomId(9),
    name: `file-${i + 1}.pdf`,
    title: `Document ${i + 1}`,
    mimetype: 'application/pdf',
    filetype: 'pdf',
    size: Math.floor(Math.random() * 1000000),
    created: Math.floor(Date.now() / 1000) - 86400 * i,
    url_private: randomUrl(),
  }));

  return { ok: true, files };
}

// GitHub generators
export function generateGitHubRepos(query: any) {
  const perPage = parseInt(query.per_page || '100');
  const repositories = Array.from({ length: Math.min(perPage, 50) }, (_, i) => ({
    id: Math.floor(Math.random() * 1000000),
    name: `repo-${i + 1}`,
    full_name: `user/repo-${i + 1}`,
    private: Math.random() > 0.5,
    description: `Repository description ${i + 1}`,
    fork: false,
    created_at: randomDate(365),
    updated_at: randomDate(30),
    pushed_at: randomDate(7),
    size: Math.floor(Math.random() * 10000),
    stargazers_count: Math.floor(Math.random() * 1000),
    language: ['JavaScript', 'TypeScript', 'Python', 'Go'][Math.floor(Math.random() * 4)],
  }));

  return { repositories };
}

export function generateGitHubStarredRepos(query: any) {
  return generateGitHubRepos(query);
}

export function generateGitHubIssues(query: any) {
  const perPage = parseInt(query.per_page || '100');
  const issues = Array.from({ length: Math.min(perPage, 30) }, (_, i) => ({
    id: Math.floor(Math.random() * 1000000),
    number: i + 1,
    title: `Issue ${i + 1}`,
    state: ['open', 'closed'][Math.floor(Math.random() * 2)],
    created_at: randomDate(90),
    updated_at: randomDate(30),
    body: `This is the body of issue ${i + 1}`,
    user: {
      login: randomName().toLowerCase(),
    },
  }));

  return { issues };
}

export function generateGitHubPullRequests(query: any) {
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: Math.floor(Math.random() * 1000000),
    number: i + 1,
    title: `Pull Request ${i + 1}`,
    state: ['open', 'closed'][Math.floor(Math.random() * 2)],
    created_at: randomDate(90),
    updated_at: randomDate(30),
    pull_request: {},
  }));

  return { items };
}

export function generateGitHubEvents(username: string, query: any) {
  const events = Array.from({ length: 30 }, (_, i) => ({
    id: randomId(),
    type: ['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'WatchEvent'][Math.floor(Math.random() * 4)],
    created_at: randomDate(30),
    repo: {
      name: `user/repo-${Math.floor(Math.random() * 10)}`,
    },
  }));

  return { events };
}

// Twitter generators
export function generateTwitterTweets(userId: string, query: any) {
  const maxResults = parseInt(query.max_results || '100');
  const data = Array.from({ length: Math.min(maxResults, 50) }, (_, i) => ({
    id: randomId(19),
    text: `This is tweet ${i + 1} from the user`,
    created_at: randomDate(30),
    author_id: userId,
    public_metrics: {
      retweet_count: Math.floor(Math.random() * 100),
      reply_count: Math.floor(Math.random() * 50),
      like_count: Math.floor(Math.random() * 200),
      quote_count: Math.floor(Math.random() * 20),
    },
  }));

  return {
    data,
    meta: {
      result_count: data.length,
      next_token: data.length >= maxResults ? randomId() : undefined,
    },
  };
}

export function generateTwitterLikedTweets(userId: string, query: any) {
  return generateTwitterTweets(userId, query);
}

// LinkedIn generators
export function generateLinkedInPosts(query: any) {
  const count = parseInt(query.count || '100');
  const elements = Array.from({ length: Math.min(count, 30) }, (_, i) => ({
    id: randomId(),
    author: `urn:li:person:${randomId()}`,
    created: {
      time: new Date(randomDate()).getTime(),
    },
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: {
          text: `This is a LinkedIn post ${i + 1}`,
        },
      },
    },
  }));

  return { elements };
}

export function generateLinkedInConnections(query: any) {
  const count = parseInt(query.count || '100');
  const elements = Array.from({ length: Math.min(count, 50) }, (_, i) => ({
    id: randomId(),
    localizedFirstName: randomName(),
    localizedLastName: randomName(),
    headline: `Professional Title ${i + 1}`,
  }));

  return { elements };
}

// Spotify generators
export function generateSpotifyPlaylists(query: any) {
  const limit = parseInt(query.limit || '50');
  const items = Array.from({ length: Math.min(limit, 20) }, (_, i) => ({
    id: randomId(22),
    name: `Playlist ${i + 1}`,
    description: `My awesome playlist ${i + 1}`,
    tracks: {
      total: Math.floor(Math.random() * 100),
    },
    images: [{ url: randomUrl() }],
  }));

  return { items };
}

export function generateSpotifyPlaylistTracks(playlistId: string, query: any) {
  const limit = parseInt(query.limit || '100');
  const items = Array.from({ length: Math.min(limit, 50) }, (_, i) => ({
    added_at: randomDate(),
    track: {
      id: randomId(22),
      name: `Song ${i + 1}`,
      artists: [{ name: randomName() }],
      album: { name: `Album ${i + 1}` },
      duration_ms: 180000 + Math.floor(Math.random() * 120000),
    },
  }));

  return { items };
}

export function generateSpotifySavedTracks(query: any) {
  return generateSpotifyPlaylistTracks('saved', query);
}

export function generateSpotifyRecentlyPlayed(query: any) {
  const limit = parseInt(query.limit || '50');
  const items = Array.from({ length: Math.min(limit, 30) }, (_, i) => ({
    played_at: randomDate(7),
    track: {
      id: randomId(22),
      name: `Recently Played ${i + 1}`,
      artists: [{ name: randomName() }],
      duration_ms: 180000,
    },
  }));

  return { items, cursors: { after: randomId() } };
}

// Instagram generators
export function generateInstagramMedia(query: any) {
  const limit = parseInt(query.limit || '100');
  const data = Array.from({ length: Math.min(limit, 25) }, (_, i) => ({
    id: randomId(17),
    caption: `Instagram post ${i + 1}`,
    media_type: ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'][Math.floor(Math.random() * 3)],
    media_url: randomUrl(),
    permalink: randomUrl(),
    timestamp: randomDate(),
  }));

  return {
    data,
    paging: {
      cursors: { after: data.length >= limit ? randomId() : undefined },
    },
  };
}

// Twitch generators
export function generateTwitchVideos(query: any) {
  const first = parseInt(query.first || '100');
  const data = Array.from({ length: Math.min(first, 30) }, (_, i) => ({
    id: randomId(),
    user_id: query.user_id,
    title: `Stream VOD ${i + 1}`,
    description: `Stream description ${i + 1}`,
    created_at: randomDate(),
    url: randomUrl(),
    duration: '2h30m15s',
    view_count: Math.floor(Math.random() * 10000),
  }));

  return {
    data,
    pagination: { cursor: data.length >= first ? randomId() : undefined },
  };
}

export function generateTwitchFollows(query: any) {
  const first = parseInt(query.first || '100');
  const data = Array.from({ length: Math.min(first, 50) }, (_, i) => ({
    from_id: query.from_id,
    to_id: randomId(),
    to_name: `Streamer${i + 1}`,
    followed_at: randomDate(),
  }));

  return {
    data,
    pagination: { cursor: data.length >= first ? randomId() : undefined },
  };
}

export function generateTwitchClips(query: any) {
  const first = parseInt(query.first || '100');
  const data = Array.from({ length: Math.min(first, 20) }, (_, i) => ({
    id: randomId(),
    url: randomUrl(),
    title: `Epic Clip ${i + 1}`,
    created_at: randomDate(),
    view_count: Math.floor(Math.random() * 5000),
    duration: Math.floor(Math.random() * 60),
  }));

  return {
    data,
    pagination: { cursor: data.length >= first ? randomId() : undefined },
  };
}

// Reddit generators
export function generateRedditPosts(username: string, query: any) {
  const limit = parseInt(query.limit || '100');
  const children = Array.from({ length: Math.min(limit, 30) }, (_, i) => ({
    kind: 't3',
    data: {
      id: randomId(6),
      title: `Reddit post ${i + 1}`,
      selftext: `This is the content of post ${i + 1}`,
      author: username,
      subreddit: `subreddit${Math.floor(Math.random() * 10)}`,
      created_utc: Math.floor(new Date(randomDate()).getTime() / 1000),
      score: Math.floor(Math.random() * 1000),
      num_comments: Math.floor(Math.random() * 100),
    },
  }));

  return {
    data: {
      children,
      after: children.length >= limit ? randomId() : null,
    },
  };
}

export function generateRedditComments(username: string, query: any) {
  return generateRedditPosts(username, query);
}

export function generateRedditSaved(username: string, query: any) {
  return generateRedditPosts(username, query);
}

// Steam generators
export function generateSteamGames(query: any) {
  const games = Array.from({ length: 50 }, (_, i) => ({
    appid: 100000 + i,
    name: `Game ${i + 1}`,
    playtime_forever: Math.floor(Math.random() * 10000),
    playtime_windows_forever: Math.floor(Math.random() * 10000),
    img_icon_url: randomId(40),
  }));

  return { response: { game_count: games.length, games } };
}

export function generateSteamAchievements(query: any) {
  const achievements = Array.from({ length: 20 }, (_, i) => ({
    apiname: `achievement_${i + 1}`,
    achieved: Math.random() > 0.5 ? 1 : 0,
    unlocktime: Math.random() > 0.5 ? Math.floor(Date.now() / 1000) - 86400 * i : 0,
  }));

  return { playerstats: { steamID: query.steamid, achievements } };
}

export function generateSteamRecentGames(query: any) {
  const games = Array.from({ length: 10 }, (_, i) => ({
    appid: 100000 + i,
    name: `Recent Game ${i + 1}`,
    playtime_2weeks: Math.floor(Math.random() * 1000),
    playtime_forever: Math.floor(Math.random() * 10000),
    img_icon_url: randomId(40),
  }));

  return { response: { total_count: games.length, games } };
}

// Notion generators
export function generateNotionPages(query: any) {
  const pageSize = parseInt(query.page_size || '100');
  const results = Array.from({ length: Math.min(pageSize, 20) }, (_, i) => ({
    object: 'page',
    id: randomId(32),
    created_time: randomDate(),
    last_edited_time: randomDate(7),
    properties: {
      title: {
        title: [{ plain_text: `Page ${i + 1}` }],
      },
    },
  }));

  return { results, next_cursor: results.length >= pageSize ? randomId() : null };
}

export function generateNotionPageContent(pageId: string) {
  return {
    object: 'page',
    id: pageId,
    created_time: randomDate(),
    properties: {
      title: {
        title: [{ plain_text: 'Sample Page' }],
      },
    },
  };
}

export function generateNotionDatabaseQuery(databaseId: string, query: any) {
  return generateNotionPages(query);
}

// Dropbox generators
export function generateDropboxFiles(query: any) {
  const entries = Array.from({ length: 30 }, (_, i) => ({
    '.tag': i % 3 === 0 ? 'folder' : 'file',
    name: i % 3 === 0 ? `Folder ${i + 1}` : `File ${i + 1}.pdf`,
    id: `id:${randomId(32)}`,
    path_lower: `/documents/${i % 3 === 0 ? 'folder' : 'file'}-${i + 1}`,
    size: i % 3 === 0 ? undefined : Math.floor(Math.random() * 1000000),
    server_modified: randomDate(),
  }));

  return { entries, cursor: randomId(), has_more: false };
}

export function generateDropboxFilesContinue(query: any) {
  return generateDropboxFiles(query);
}

// Box generators
export function generateBoxFiles(folderId: string, query: any) {
  const entries = Array.from({ length: 30 }, (_, i) => ({
    type: i % 3 === 0 ? 'folder' : 'file',
    id: randomId(),
    name: i % 3 === 0 ? `Folder ${i + 1}` : `File ${i + 1}.pdf`,
    size: i % 3 === 0 ? undefined : Math.floor(Math.random() * 1000000),
    created_at: randomDate(),
    modified_at: randomDate(7),
  }));

  return { entries, total_count: entries.length };
}

export function generateBoxFileInfo(fileId: string) {
  return {
    type: 'file',
    id: fileId,
    name: 'Sample File.pdf',
    size: 524288,
    created_at: randomDate(),
    modified_at: randomDate(7),
  };
}

// Nextcloud generators
export function generateNextcloudFiles(userId: string) {
  const response = Array.from({ length: 20 }, (_, i) => ({
    href: `/remote.php/dav/files/${userId}/file-${i + 1}.pdf`,
    propstat: {
      prop: {
        displayname: `File ${i + 1}.pdf`,
        getcontentlength: Math.floor(Math.random() * 1000000),
        getlastmodified: randomDate(),
      },
    },
  }));

  return { multistatus: { response } };
}

export function generateNextcloudContacts(userId: string) {
  const response = Array.from({ length: 20 }, (_, i) => ({
    href: `/remote.php/dav/addressbooks/users/${userId}/contacts/contact-${i + 1}.vcf`,
    propstat: {
      prop: {
        displayname: randomName(),
        getetag: randomId(),
      },
    },
  }));

  return { multistatus: { response } };
}

export function generateNextcloudCalendar(userId: string) {
  const response = Array.from({ length: 20 }, (_, i) => ({
    href: `/remote.php/dav/calendars/${userId}/personal/event-${i + 1}.ics`,
    propstat: {
      prop: {
        displayname: `Event ${i + 1}`,
        getetag: randomId(),
      },
    },
  }));

  return { multistatus: { response } };
}

// Shopify generators
export function generateShopifyOrders(query: any) {
  const orders = Array.from({ length: 30 }, (_, i) => ({
    id: 1000000 + i,
    email: randomEmail(),
    created_at: randomDate(),
    total_price: (Math.random() * 500 + 10).toFixed(2),
    line_items: [
      {
        title: `Product ${i + 1}`,
        quantity: Math.floor(Math.random() * 5) + 1,
        price: (Math.random() * 100 + 5).toFixed(2),
      },
    ],
  }));

  return { orders };
}

export function generateShopifyProducts(query: any) {
  const products = Array.from({ length: 50 }, (_, i) => ({
    id: 2000000 + i,
    title: `Product ${i + 1}`,
    vendor: `Vendor ${Math.floor(Math.random() * 10)}`,
    product_type: ['Electronics', 'Clothing', 'Books', 'Food'][Math.floor(Math.random() * 4)],
    created_at: randomDate(365),
    updated_at: randomDate(30),
    variants: [
      {
        id: 3000000 + i,
        price: (Math.random() * 200 + 10).toFixed(2),
        inventory_quantity: Math.floor(Math.random() * 100),
      },
    ],
  }));

  return { products };
}

export function generateShopifyCustomers(query: any) {
  const customers = Array.from({ length: 40 }, (_, i) => ({
    id: 4000000 + i,
    email: randomEmail(),
    first_name: randomName(),
    last_name: randomName(),
    created_at: randomDate(365),
    orders_count: Math.floor(Math.random() * 20),
    total_spent: (Math.random() * 5000).toFixed(2),
  }));

  return { customers };
}

// Stripe generators
export function generateStripeCharges(query: any) {
  const data = Array.from({ length: 30 }, (_, i) => ({
    id: `ch_${randomId(24)}`,
    object: 'charge',
    amount: Math.floor(Math.random() * 50000) + 1000,
    currency: 'usd',
    created: Math.floor(Date.now() / 1000) - i * 86400,
    status: 'succeeded',
    customer: `cus_${randomId(14)}`,
  }));

  return { object: 'list', data, has_more: false };
}

export function generateStripePaymentIntents(query: any) {
  const data = Array.from({ length: 30 }, (_, i) => ({
    id: `pi_${randomId(24)}`,
    object: 'payment_intent',
    amount: Math.floor(Math.random() * 50000) + 1000,
    currency: 'usd',
    created: Math.floor(Date.now() / 1000) - i * 86400,
    status: 'succeeded',
  }));

  return { object: 'list', data, has_more: false };
}

export function generateStripeCustomers(query: any) {
  const data = Array.from({ length: 30 }, (_, i) => ({
    id: `cus_${randomId(14)}`,
    object: 'customer',
    email: randomEmail(),
    name: randomName(),
    created: Math.floor(Date.now() / 1000) - i * 86400,
  }));

  return { object: 'list', data, has_more: false };
}

export function generateStripeSubscriptions(query: any) {
  const data = Array.from({ length: 20 }, (_, i) => ({
    id: `sub_${randomId(14)}`,
    object: 'subscription',
    customer: `cus_${randomId(14)}`,
    status: ['active', 'canceled', 'past_due'][Math.floor(Math.random() * 3)],
    created: Math.floor(Date.now() / 1000) - i * 86400,
  }));

  return { object: 'list', data, has_more: false };
}

// Trello generators
export function generateTrelloBoards(query: any) {
  const boards = Array.from({ length: 10 }, (_, i) => ({
    id: randomId(24),
    name: `Board ${i + 1}`,
    desc: `Description for board ${i + 1}`,
    closed: false,
    url: randomUrl(),
    dateLastActivity: randomDate(),
  }));

  return { boards };
}

export function generateTrelloCards(query: any) {
  const cards = Array.from({ length: 30 }, (_, i) => ({
    id: randomId(24),
    name: `Card ${i + 1}`,
    desc: `Description for card ${i + 1}`,
    closed: false,
    idBoard: randomId(24),
    idList: randomId(24),
    due: Math.random() > 0.5 ? randomDate(30) : null,
    url: randomUrl(),
  }));

  return { cards };
}

// Asana generators
export function generateAsanaTasks(userTaskListGid: string, query: any) {
  const data = Array.from({ length: 30 }, (_, i) => ({
    gid: randomId(),
    name: `Task ${i + 1}`,
    notes: `Notes for task ${i + 1}`,
    completed: Math.random() > 0.5,
    due_on: Math.random() > 0.5 ? randomDate(30).split('T')[0] : null,
  }));

  return { data };
}

export function generateAsanaProjects(query: any) {
  const data = Array.from({ length: 15 }, (_, i) => ({
    gid: randomId(),
    name: `Project ${i + 1}`,
    created_at: randomDate(365),
    modified_at: randomDate(30),
  }));

  return { data };
}

// Zoom generators
export function generateZoomMeetings(query: any) {
  const meetings = Array.from({ length: 20 }, (_, i) => ({
    uuid: randomId(22),
    id: 1000000000 + i,
    topic: `Meeting ${i + 1}`,
    type: 2,
    start_time: randomDate(30),
    duration: 60,
    timezone: 'America/Los_Angeles',
  }));

  return { meetings, next_page_token: '' };
}

export function generateZoomRecordings(query: any) {
  const meetings = Array.from({ length: 10 }, (_, i) => ({
    uuid: randomId(22),
    id: 1000000000 + i,
    topic: `Recorded Meeting ${i + 1}`,
    start_time: randomDate(30),
    duration: 90,
    recording_files: [
      {
        id: randomId(),
        file_type: 'MP4',
        file_size: Math.floor(Math.random() * 500000000),
        download_url: randomUrl(),
      },
    ],
  }));

  return { meetings, next_page_token: '' };
}

// Telegram generators
export function generateTelegramUpdates(query: any) {
  const result = Array.from({ length: 20 }, (_, i) => ({
    update_id: 100000 + i,
    message: {
      message_id: 1000 + i,
      from: {
        id: Math.floor(Math.random() * 1000000),
        first_name: randomName(),
        username: randomName().toLowerCase(),
      },
      chat: {
        id: Math.floor(Math.random() * 1000000),
        type: 'private',
      },
      date: Math.floor(new Date(randomDate()).getTime() / 1000),
      text: `Message ${i + 1}`,
    },
  }));

  return { ok: true, result };
}

export function generateTelegramMessages(query: any) {
  return generateTelegramUpdates(query);
}

// Signal generators
export function generateSignalMessages(query: any) {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: randomId(),
    timestamp: new Date(randomDate()).getTime(),
    source: randomName(),
    message: `Signal message ${i + 1}`,
  }));

  return { messages };
}

// OpenAI generators
export function generateOpenAIConversations(query: any) {
  const data = Array.from({ length: 20 }, (_, i) => ({
    id: randomId(32),
    title: `Conversation ${i + 1}`,
    created_at: Math.floor(new Date(randomDate()).getTime() / 1000),
    updated_at: Math.floor(new Date(randomDate(7)).getTime() / 1000),
  }));

  return { data };
}

export function generateOpenAIModels() {
  const data = [
    { id: 'gpt-4', object: 'model', owned_by: 'openai' },
    { id: 'gpt-3.5-turbo', object: 'model', owned_by: 'openai' },
    { id: 'text-davinci-003', object: 'model', owned_by: 'openai' },
  ];

  return { data };
}

// Anthropic generators
export function generateAnthropicMessages(query: any) {
  const data = Array.from({ length: 20 }, (_, i) => ({
    id: `msg_${randomId(27)}`,
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `Response ${i + 1}`,
      },
    ],
    model: 'claude-3-opus-20240229',
    stop_reason: 'end_turn',
    created_at: Math.floor(new Date(randomDate()).getTime() / 1000),
  }));

  return { data, next_page_token: data.length >= 20 ? randomId() : null };
}
