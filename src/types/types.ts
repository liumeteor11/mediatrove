export enum MediaType {
  BOOK = 'Book',
  MOVIE = 'Movie',
  TV_SERIES = 'TV Series',
  COMIC = 'Comic',
  SHORT_DRAMA = 'Short Drama',
  MUSIC = 'Music',
  OTHER = 'Other'
}

export enum CollectionCategory {
  FAVORITES = 'Favorites',
  TO_WATCH = 'To Watch',
  WATCHED = 'Watched'
}

export interface SeasonInfo {
  season: number;
  total: number; // episode/chapter count of this season
  released?: number; // aired so far; defaults to total when absent
}

export interface MediaItem {
  id: string; // generated UUID or unique ID from AI
  title: string;
  directorOrAuthor: string;
  description: string;
  releaseDate: string;
  type: MediaType;
  isOngoing: boolean;
  latestUpdateInfo?: string; // e.g., "Chapter 105" or "Season 3 Episode 2"
  category?: CollectionCategory; // Local state property
  savedAt?: number;
  posterUrl?: string; // URL for the poster image
  rating?: string; // e.g., "8.5/10"
  cast?: string[]; // Main actors (max 5)

  tmdbId?: number;
  tmdbMediaType?: 'movie' | 'tv';
  contentLang?: 'zh' | 'en'; // Language the metadata was fetched in (stamped by searchMedia); update checks keep it

  // Tracking fields
  userProgress?: string; // e.g. "S1E5" or "Chapter 10"
  totalEpisodes?: number; // Episode/chapter count of the current season (or whole work when finished); drives the episode grid
  seasons?: SeasonInfo[]; // Structured per-season counts (S1 N集 / S2 M集) from authoritative checks
  episodeSource?: EpisodeSource; // Provenance of the accepted episode counts; later checks compare source reliability against it
  updateConflict?: string; // Human-readable note when a weaker source claimed different counts than the stored trusted ones
  posterFailedAt?: number; // Last time posterUrl failed to load at runtime; makes repair sweeps re-fetch it
  posterLocalAt?: number; // Set when a local cached copy of the poster exists (survives URL decay and offline use)
  notificationEnabled?: boolean;
  lastCheckedAt?: number;
  hasNewUpdate?: boolean; // New field for tracking updates

  // Customization fields
  userReview?: string; // Rich text content for user review
  customPosterUrl?: string; // User uploaded poster URL
  lastEditedAt?: number; // Timestamp of last edit

  // Backend-aligned fields
  status?: string;
  addedAt?: string;
  userRating?: number;

  // Collection fields
  parentCollectionId?: string; // If set, this item belongs to a collection
  isCollection?: boolean; // If true, this item is a container for other items
  isPinned?: boolean;
}

export interface User {
  username: string;
  githubToken?: string;
  lastBackup?: string;
}

export type IOChannel = 'ai' | 'search';
export interface AIIOLogEntry {
  id: string;
  ts: number;
  channel: IOChannel;
  provider?: string;
  query?: string;
  request?: any;
  response?: any;
  durationMs?: number;
  searchType?: 'text' | 'image';
  model?: string;
  baseURL?: string;
}

export interface SearchDiagnosticsStep {
  name: string;
  durationMs: number;
  provider?: string;
  details?: any;
}

export interface SearchDiagnosticsQuota {
  provider: string;
  unit: 'request' | 'token';
  amount: number;
  details?: any;
}

// Provenance of the accepted episode/update information. Lower `kind` trust
// rank beats higher: a stored TMDB value must not be overwritten by an AI
// claim, manual edits outrank everything (only growth is accepted on top).
export type EpisodeSourceKind = 'manual' | 'tmdb' | 'official' | 'wiki' | 'aggregator' | 'ai';

export interface EpisodeSource {
  url?: string; // Clickable source page, shown in the item detail
  kind: EpisodeSourceKind;
  at: number; // When this source was recorded
  total?: number; // The count this source reported (audit trail)
  released?: number;
}

export interface SearchDiagnostics {
  query: string;
  type: string;
  at: string;
  totalDurationMs: number;
  providers: string[];
  steps: SearchDiagnosticsStep[];
  quota: SearchDiagnosticsQuota[];
}

// Progress phases of searchMedia, surfaced as live status text on the search
// page while a search runs (sources → rewrite → websearch → verify).
export type SearchPhase = 'sources' | 'rewrite' | 'websearch' | 'verify';

