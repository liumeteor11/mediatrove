use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CollectionData {
    pub users: Vec<UserRecord>,
    pub items_by_user: HashMap<String, Vec<MediaItem>>,
    // Legacy field for compatibility
    #[serde(default)]
    pub items: Vec<MediaItem>,
    /// Distilled character profiles, per user.
    #[serde(default)]
    pub characters_by_user: HashMap<String, Vec<DistilledCharacter>>,
    /// Roleplay chat sessions with distilled characters, per user.
    #[serde(default)]
    pub chat_sessions_by_user: HashMap<String, Vec<ChatSession>>,
    pub ai_config: Option<AIConfig>,
    pub theme_config: Option<ThemeConfig>,
    /// Shared pairing secret required by the LAN sync endpoints.
    /// Never transmitted as part of sync payloads.
    #[serde(default)]
    pub sync_token: String,
    /// Local MCP server config (external AI agents read/write the collection).
    #[serde(default)]
    pub mcp_config: Option<McpConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_mcp_port")]
    pub port: u16,
    #[serde(default = "default_mcp_user")]
    pub username: String,
}

fn default_mcp_port() -> u16 {
    8787
}

fn default_mcp_user() -> String {
    "guest".to_string()
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_mcp_port(),
            username: default_mcp_user(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRecord {
    pub username: String,
    pub password_hash: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPublic {
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: String,
    pub title: String,
    #[serde(rename = "directorOrAuthor")]
    pub director_or_author: String,
    pub description: String,
    #[serde(rename = "releaseDate")]
    pub release_date: String,
    #[serde(rename = "type")]
    pub kind: String, 
    #[serde(rename = "isOngoing")]
    pub is_ongoing: bool,
    #[serde(rename = "latestUpdateInfo")]
    pub latest_update_info: Option<String>,
    pub category: Option<String>,
    #[serde(rename = "savedAt")]
    pub saved_at: Option<u64>,
    #[serde(rename = "posterUrl")]
    pub poster_url: Option<String>,
    pub rating: Option<String>,
    pub cast: Option<Vec<String>>,
    #[serde(rename = "tmdbId")]
    pub tmdb_id: Option<i32>,
    #[serde(rename = "tmdbMediaType")]
    pub tmdb_media_type: Option<String>,
    #[serde(rename = "userProgress")]
    pub user_progress: Option<String>,
    #[serde(rename = "notificationEnabled")]
    pub notification_enabled: Option<bool>,
    #[serde(rename = "lastCheckedAt")]
    pub last_checked_at: Option<u64>,
    #[serde(rename = "hasNewUpdate")]
    pub has_new_update: Option<bool>,
    #[serde(rename = "userReview")]
    pub user_review: Option<String>,
    #[serde(rename = "customPosterUrl")]
    pub custom_poster_url: Option<String>,
    #[serde(rename = "lastEditedAt")]
    pub last_edited_at: Option<u64>,
    pub status: Option<String>,
    #[serde(rename = "addedAt")]
    pub added_at: Option<String>,
    #[serde(rename = "userRating")]
    pub user_rating: Option<f32>,
    #[serde(rename = "parentCollectionId")]
    pub parent_collection_id: Option<String>,
    #[serde(rename = "isCollection")]
    pub is_collection: Option<bool>,
    #[serde(rename = "isPinned")]
    pub is_pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeConfig {
    pub theme: String,
}

// --- Distilled characters (persona profiles) ---

/// How the character speaks; distilled from the work and enforced in chat prompts.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExpressionDNA {
    pub tone: Option<String>,
    /// Formality from 1 (very formal) to 5 (very colloquial); 0 = unknown.
    #[serde(default)]
    pub formality: i32,
    #[serde(default)]
    pub catchphrases: Vec<String>,
    #[serde(default)]
    pub vocabulary: Vec<String>,
    #[serde(rename = "sentenceStyle")]
    pub sentence_style: Option<String>,
    #[serde(rename = "exampleLines", default)]
    pub example_lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterRelation {
    pub name: String,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEvent {
    pub period: String,
    pub event: String,
}

/// User-issued correction (distilly-style correction layer). Corrections are
/// injected into the chat system prompt and take precedence over the persona.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterCorrection {
    pub scene: String,
    pub wrong: String,
    pub correct: String,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistilledCharacter {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    #[serde(rename = "sourceMediaId")]
    pub source_media_id: Option<String>,
    #[serde(rename = "sourceType")]
    pub source_type: Option<String>,
    pub tagline: Option<String>,
    pub appearance: Option<String>,
    #[serde(default)]
    pub personality: Vec<String>,
    #[serde(rename = "mentalModels", default)]
    pub mental_models: Vec<String>,
    #[serde(rename = "decisionHeuristics", default)]
    pub decision_heuristics: Vec<String>,
    pub interpersonal: Option<String>,
    #[serde(default)]
    pub boundaries: Vec<String>,
    pub background: Option<String>,
    pub expression: Option<ExpressionDNA>,
    #[serde(default)]
    pub relationships: Vec<CharacterRelation>,
    #[serde(default)]
    pub quotes: Vec<String>,
    #[serde(rename = "externalViews", default)]
    pub external_views: Vec<String>,
    #[serde(default)]
    pub timeline: Vec<TimelineEvent>,
    #[serde(default)]
    pub corrections: Vec<CharacterCorrection>,
    /// Bumped on every incremental re-distillation / correction.
    #[serde(default)]
    pub version: u32,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    /// In-character first message inserted into new chat sessions.
    pub greeting: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
}

// --- Roleplay chat sessions ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    /// "user" | "assistant"
    pub role: String,
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    #[serde(rename = "characterId")]
    pub character_id: String,
    pub title: String,
    /// Rolling summary of the archived message prefix (see summarizedUpTo).
    #[serde(default)]
    pub summary: Option<String>,
    /// Messages up to (exclusive of) this index are covered by `summary`
    /// and are no longer replayed verbatim (nanobot-style archive offset).
    #[serde(rename = "summarizedUpTo", default)]
    pub summarized_up_to: usize,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIConfig {
    pub provider: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub model: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "maxTokens")]
    pub max_tokens: i32,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: String,
    #[serde(rename = "enableSearch")]
    pub enable_search: bool,
    #[serde(rename = "searchProvider")]
    pub search_provider: String,
    #[serde(rename = "googleSearchApiKey")]
    pub google_search_api_key: String,
    #[serde(rename = "googleSearchCx")]
    pub google_search_cx: String,
    #[serde(rename = "serperApiKey")]
    pub serper_api_key: String,
    #[serde(rename = "yandexSearchApiKey")]
    pub yandex_search_api_key: String,
    #[serde(rename = "yandexSearchLogin")]
    pub yandex_search_login: String,
    #[serde(rename = "omdbApiKey")]
    pub omdb_api_key: String,
    #[serde(rename = "tmdbApiKey")]
    pub tmdb_api_key: String,
    #[serde(rename = "bangumiToken")]
    pub bangumi_token: String,
    #[serde(rename = "enableTmdb")]
    pub enable_tmdb: bool,
    #[serde(rename = "enableBangumi")]
    pub enable_bangumi: bool,
    #[serde(rename = "enableNetworking")]
    pub enable_networking: bool,
    #[serde(rename = "reasoningEffort", default = "default_reasoning_effort")]
    pub reasoning_effort: String,
    #[serde(rename = "enableTrending")]
    pub enable_trending: bool,
    #[serde(rename = "trendingPrompt")]
    pub trending_prompt: String,
    #[serde(rename = "useSystemProxy")]
    pub use_system_proxy: bool,
    #[serde(rename = "proxyProtocol")]
    pub proxy_protocol: String,
    #[serde(rename = "proxyHost")]
    pub proxy_host: String,
    #[serde(rename = "proxyPort")]
    pub proxy_port: String,
    #[serde(rename = "proxyUsername")]
    pub proxy_username: String,
    #[serde(rename = "proxyPassword")]
    pub proxy_password: String,
    #[serde(rename = "authoritativeDomains")]
    pub authoritative_domains: AuthoritativeDomains,
}

fn default_reasoning_effort() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthoritativeDomains {
    pub movie_tv: Vec<String>,
    pub book: Vec<String>,
    pub comic: Vec<String>,
    pub music: Vec<String>,
    pub poster: Vec<String>,
}
