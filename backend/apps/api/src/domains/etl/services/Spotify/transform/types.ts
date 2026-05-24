export interface SpotifyTrack {
  album?: {
    album_type?: string;
    total_tracks?: number;
    available_markets?: string[];
    external_urls?: {
      spotify: string;
    };
    href?: string;
    id?: string;
    images?: Array<{
      url: string;
      height: number;
      width: number;
    }>;
    name?: string;
    release_date?: string;
    release_date_precision?: string;
    type?: string;
    uri?: string;
    artists?: Array<{
      external_urls?: {
        spotify: string;
      };
      href?: string;
      id?: string;
      name?: string;
      type?: string;
      uri?: string;
    }>;
  };
  artists?: Array<{
    external_urls?: {
      spotify: string;
    };
    href?: string;
    id?: string;
    name?: string;
    type?: string;
    uri?: string;
  }>;
  available_markets?: string[];
  disc_number?: number;
  duration_ms: number;
  explicit?: boolean;
  external_ids?: {
    isrc?: string;
    ean?: string;
    upc?: string;
  };
  external_urls?: {
    spotify: string;
  };
  href?: string;
  id: string;
  is_playable?: boolean;
  linked_from?: Record<string, unknown>;
  restrictions?: {
    reason?: string;
  };
  name: string;
  popularity?: number;
  preview_url?: string;
  track_number?: number;
  type?: string;
  uri?: string;
  is_local?: boolean;
}

export interface SpotifyPlaylistTrackItem {
  track: SpotifyTrack;
  played_at?: string;
  added_at?: string;
  context?: {
    type?: string;
    href?: string;
    external_urls?: {
      spotify: string;
    };
    uri?: string;
  };
}

export interface SpotifyPlaylist {
  collaborative: boolean;
  description?: string;
  external_urls?: {
    spotify: string;
  };
  href: string;
  id: string;
  images?: Array<{
    url: string;
    height: number;
    width: number;
  }>;
  name: string;
  owner: {
    external_urls: {
      spotify: string;
    };
    href: string;
    id: string;
    type: string;
    uri: string;
    display_name: string;
  };
  public: boolean;
  snapshot_id: string;
  tracks?: {
    href: string;
    total: number;
    items?: SpotifyPlaylistTrackItem[];
  };
  type: string;
  uri: string;
}

export interface SpotifyArtist {
  external_urls?: {
    spotify: string;
  };
  followers?: {
    href?: string;
    total: number;
  };
  genres?: string[];
  href: string;
  id: string;
  images?: Array<{
    url: string;
    height: number;
    width: number;
  }>;
  name: string;
  popularity?: number;
  type: string;
  uri: string;
}

export interface SpotifyShow {
  added_at?: string;
  show: {
    copyrights?: Array<{
      text: string;
      type: string;
    }>;
    description: string;
    html_description?: string;
    explicit: boolean;
    external_urls: {
      spotify: string;
    };
    href: string;
    id: string;
    images: Array<{
      url: string;
      height: number;
      width: number;
    }>;
    is_externally_hosted?: boolean;
    languages?: string[];
    media_type: string;
    name: string;
    type: string;
    uri: string;
    total_episodes?: number;
  };
}

export interface SpotifyEpisode {
  added_at?: string;
  episode: {
    audio_preview_url?: string;
    description: string;
    html_description?: string;
    duration_ms: number;
    explicit: boolean;
    external_urls: {
      spotify: string;
    };
    href: string;
    id: string;
    images: Array<{
      url: string;
      height: number;
      width: number;
    }>;
    is_externally_hosted?: boolean;
    is_playable: boolean;
    language?: string;
    languages?: string[];
    name: string;
    release_date: string;
    release_date_precision: string;
    resume_point?: {
      fully_played: boolean;
      resume_position_ms: number;
    };
    type: string;
    uri: string;
    restrictions?: {
      reason: string;
    };
    show: {
      available_markets?: string[];
      copyrights?: Array<{
        text: string;
        type: string;
      }>;
      description: string;
      html_description?: string;
      explicit: boolean;
      external_urls: {
        spotify: string;
      };
      href: string;
      id: string;
      images: Array<{
        url: string;
        height: number;
        width: number;
      }>;
      is_externally_hosted?: boolean;
      languages?: string[];
      media_type: string;
      name: string;
      publisher: string;
      type: string;
      uri: string;
      total_episodes?: number;
    };
  };
}

export interface SpotifyAudiobook {
  authors: Array<{
    name: string;
  }>;
  available_markets?: string[];
  copyrights?: Array<{
    text: string;
    type: string;
  }>;
  description: string;
  html_description?: string;
  edition?: string;
  explicit: boolean;
  external_urls: {
    spotify: string;
  };
  href: string;
  id: string;
  images: Array<{
    url: string;
    height: number;
    width: number;
  }>;
  languages?: string[];
  media_type: string;
  name: string;
  narrators: Array<{
    name: string;
  }>;
  publisher: string;
  type: string;
  uri: string;
  total_chapters?: number;
}
