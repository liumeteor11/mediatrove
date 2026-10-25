//! Local MCP (Model Context Protocol) server.
//!
//! Lets external AI agents (Claude Code, Cursor, ...) read and modify this
//! user's media collection over the MCP Streamable HTTP transport. Runs an
//! axum router on 127.0.0.1 only, and shares the same `Database` cache the
//! app UI uses, so writes persist to collection.json exactly like UI edits.
//! Mutating tools emit a `mcp:data-changed` Tauri event so the frontend can
//! refresh its stores.

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::database::Database;
use crate::models::McpConfig;

const SERVER_NAME: &str = "mediatrove";
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

const MEDIA_TYPES: [&str; 7] = [
    "Book",
    "Movie",
    "TV Series",
    "Comic",
    "Short Drama",
    "Music",
    "Other",
];
const CATEGORIES: [&str; 3] = ["Favorites", "To Watch", "Watched"];

/// Runtime handle for the MCP server task; managed by Tauri.
pub struct McpState {
    pub running: Arc<AtomicBool>,
    pub port: AtomicU16,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            port: AtomicU16::new(0),
            task: Mutex::new(None),
        }
    }
}

impl McpState {
    pub fn stop(&self) {
        if let Some(handle) = self.task.lock().ok().and_then(|mut t| t.take()) {
            handle.abort();
        }
        self.running.store(false, Ordering::SeqCst);
        self.port.store(0, Ordering::SeqCst);
    }

    pub fn start(
        &self,
        app: &AppHandle,
        db: Arc<Database>,
        config: &McpConfig,
        pending: Arc<McpChatPending>,
    ) {
        self.stop();
        let router = build_router(app.clone(), pending, db);
        let running = self.running.clone();
        let port = config.port;
        running.store(true, Ordering::SeqCst);
        self.port.store(port, Ordering::SeqCst);
        let handle = tauri::async_runtime::spawn(async move {
            match bind_listener(port).await {
                Ok((listener, bound)) => {
                    println!("MCP server listening on http://127.0.0.1:{bound}/mcp");
                    serve_listener(listener, router).await;
                }
                Err(e) => {
                    println!("MCP server failed to bind 127.0.0.1:{port}: {e}");
                }
            }
            running.store(false, Ordering::SeqCst);
        });
        if let Ok(mut t) = self.task.lock() {
            *t = Some(handle);
        }
    }
}

/// Bind the MCP listener on 127.0.0.1. Port 0 lets the OS pick a free port
/// (used by tests); the assigned port is returned with the listener.
pub(crate) async fn bind_listener(port: u16) -> std::io::Result<(tokio::net::TcpListener, u16)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let bound = listener.local_addr()?.port();
    Ok((listener, bound))
}

/// Serve an already-bound listener; returns when the server stops.
pub(crate) async fn serve_listener(listener: tokio::net::TcpListener, router: Router) {
    if let Err(e) = axum::serve(listener, router).await {
        println!("MCP server stopped: {e}");
    }
}

/// Callback fired after a mutating tool runs, so the UI can refresh.
/// Decoupled from `AppHandle` on purpose: mentioning a Tauri type here would
/// drag the GUI stack (and its comctl32 v6-only imports) into the test
/// binary, which has no embedded manifest and fails to load.
pub type NotifyFn = dyn Fn(&str, &str) + Send + Sync;

/// Runs one character-chat turn against the AI configured in the app. In
/// production this bridges to the webview (which holds the decrypted API key
/// and all provider quirks); tests inject a fake. Same decoupling rationale
/// as `NotifyFn`.
pub type ChatFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
pub type ChatBridge = dyn Fn(String, String) -> ChatFuture + Send + Sync;

/// Pending webview replies for in-flight MCP chat requests, keyed by id.
/// Shared between the HTTP router (registers senders) and the
/// `mcp_chat_reply` command (completes them).
#[derive(Default)]
pub struct McpChatPending {
    pub waiting: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<String, String>>>>,
}

#[derive(Clone)]
struct McpHttpState {
    notify: Option<Arc<NotifyFn>>,
    chat: Option<Arc<ChatBridge>>,
    db: Arc<Database>,
}

fn build_router(app: AppHandle, pending: Arc<McpChatPending>, db: Arc<Database>) -> Router {
    let notify_app = app.clone();
    let notify: Arc<NotifyFn> = Arc::new(move |username: &str, action: &str| {
        let _ = notify_app.emit(
            "mcp:data-changed",
            json!({ "username": username, "action": action }),
        );
    });
    let chat_app = app.clone();
    let chat: Arc<ChatBridge> = Arc::new(move |character_id: String, message: String| {
        let app = chat_app.clone();
        let pending = pending.clone();
        Box::pin(async move {
            let request_id = format!("chat-{}-{}", now_millis().unwrap_or(0), next_counter());
            let (tx, rx) = tokio::sync::oneshot::channel();
            {
                let mut map = pending
                    .waiting
                    .lock()
                    .map_err(|_| "bridge lock poisoned".to_string())?;
                map.insert(request_id.clone(), tx);
            }
            if let Err(e) = app.emit(
                "mcp:chat-request",
                json!({ "requestId": request_id, "characterId": character_id, "message": message }),
            ) {
                if let Ok(mut map) = pending.waiting.lock() {
                    map.remove(&request_id);
                }
                return Err(format!("failed to reach the app window: {e}"));
            }
            // Reasoning models can think for minutes; match the AI budget the
            // rest of the app grants a single reply.
            match tokio::time::timeout(Duration::from_secs(crate::AI_TOTAL_TIMEOUT_SECS), rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("the app window dropped the chat request".to_string()),
                Err(_) => {
                    if let Ok(mut map) = pending.waiting.lock() {
                        map.remove(&request_id);
                    }
                    Err("character chat timed out".to_string())
                }
            }
        })
    });
    build_router_inner(Some(notify), Some(chat), db)
}

#[cfg(test)]
pub fn build_router_for_test(db: Arc<Database>, chat: Option<Arc<ChatBridge>>) -> Router {
    build_router_inner(None, chat, db)
}

fn build_router_inner(
    notify: Option<Arc<NotifyFn>>,
    chat: Option<Arc<ChatBridge>>,
    db: Arc<Database>,
) -> Router {
    Router::new()
        .route("/mcp", post(mcp_post).get(mcp_get).delete(mcp_delete))
        .route("/mcp/", post(mcp_post).get(mcp_get).delete(mcp_delete))
        .with_state(McpHttpState { notify, chat, db })
}

// --- JSON-RPC plumbing -----------------------------------------------------

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_err(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_text(text: String) -> Value {
    json!({ "content": [ { "type": "text", "text": text } ] })
}

fn tool_error(message: String) -> Value {
    json!({ "content": [ { "type": "text", "text": message } ], "isError": true })
}

/// True when the Host (and Origin, if present) headers refer to this machine.
/// Streamable HTTP servers should validate this to block DNS-rebinding
/// attacks from random websites talking to the localhost port.
fn is_local_request(headers: &HeaderMap) -> bool {
    let allowed = ["localhost", "127.0.0.1", "[::1]", "::1"];
    let check = |value: Option<&HeaderValue>| -> bool {
        match value {
            None => true, // header absent (non-browser client) — allow
            Some(v) => {
                let host = v.to_str().unwrap_or("").to_ascii_lowercase();
                let bare = host.split(':').next().unwrap_or("").to_string();
                allowed.iter().any(|a| host == *a || bare == *a)
            }
        }
    };
    if !check(headers.get("host")) {
        return false;
    }
    if !check(headers.get("origin")) {
        return false;
    }
    true
}

async fn mcp_get() -> Response {
    // No server-initiated SSE stream: stateless server.
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

async fn mcp_delete() -> Response {
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

async fn mcp_post(
    headers: HeaderMap,
    State(state): State<McpHttpState>,
    body: axum::body::Bytes,
) -> Response {
    if !is_local_request(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let parsed: Result<Value, _> = serde_json::from_slice(&body);
    let message = match parsed {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(rpc_err(&Value::Null, -32700, "Parse error")),
            )
                .into_response()
        }
    };

    // Streamable HTTP allows JSON-RPC batches (arrays). Tool calls are async
    // (character chat awaits the webview bridge), so process sequentially.
    let messages: Vec<&Value> = if message.is_array() {
        message.as_array().map(|arr| arr.iter().collect()).unwrap_or_default()
    } else {
        vec![&message]
    };
    let mut responses: Vec<Value> = Vec::new();
    for msg in messages {
        if let Some(r) = handle_message(msg, &state).await {
            responses.push(r);
        }
    }

    if responses.is_empty() {
        // Only notifications: accept without a body.
        StatusCode::ACCEPTED.into_response()
    } else {
        let body = if responses.len() == 1 {
            responses.into_iter().next().unwrap()
        } else {
            Value::Array(responses)
        };
        (StatusCode::OK, Json(body)).into_response()
    }
}

async fn handle_message(message: &Value, state: &McpHttpState) -> Option<Value> {
    let id = message.get("id").cloned();
    // Notifications (no id) get no response.
    let id = id?;

    let method = message.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(json!({}));

    let response = match method {
        "initialize" => rpc_ok(&id, initialize_result(&params)),
        "ping" => rpc_ok(&id, json!({})),
        "tools/list" => rpc_ok(&id, build_tools_list()),
        "tools/call" => match call_tool(&params, &state.db, state.notify.as_ref(), state.chat.as_ref()).await {
            Ok(result) => rpc_ok(&id, result),
            Err(e) => rpc_ok(&id, tool_error(e)),
        },
        _ => rpc_err(&id, -32601, &format!("Method not found: {method}")),
    };
    Some(response)
}

fn initialize_result(params: &Value) -> Value {
    // Echo the client's protocol version when provided; otherwise offer ours.
    let requested = params
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let version = if requested.is_empty() {
        LATEST_PROTOCOL_VERSION
    } else {
        requested
    };
    json!({
        "protocolVersion": version,
        "capabilities": {
            "tools": { "listChanged": false }
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "title": "MediaTrove",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

// --- Tool schema ------------------------------------------------------------

pub fn build_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "list_items",
                "description": "List media items in the user's collection. Filter by category ('Favorites' | 'To Watch' | 'Watched'), media type ('Book' | 'Movie' | 'TV Series' | 'Comic' | 'Short Drama' | 'Music' | 'Other'), or a case-insensitive search over title/description.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "category": { "type": "string", "enum": CATEGORIES.to_vec() },
                        "type": { "type": "string", "enum": MEDIA_TYPES.to_vec() },
                        "search": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT }
                    }
                }
            },
            {
                "name": "get_item",
                "description": "Get a single media item by its id.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "id": { "type": "string" } },
                    "required": ["id"]
                }
            },
            {
                "name": "add_item",
                "description": "Add a media item to the collection. Category defaults to 'To Watch'; type defaults to 'Other'.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "type": { "type": "string", "enum": MEDIA_TYPES.to_vec() },
                        "category": { "type": "string", "enum": CATEGORIES.to_vec() },
                        "description": { "type": "string" },
                        "releaseDate": { "type": "string", "description": "YYYY-MM-DD or YYYY" },
                        "directorOrAuthor": { "type": "string" },
                        "isOngoing": { "type": "boolean" },
                        "rating": { "type": "string" }
                    },
                    "required": ["title"]
                }
            },
            {
                "name": "update_item",
                "description": "Update an existing media item. Provide only the fields to change (e.g. category, userProgress, userReview, latestUpdateInfo); the id cannot be changed.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "category": { "type": "string", "enum": CATEGORIES.to_vec() },
                        "description": { "type": "string" },
                        "releaseDate": { "type": "string" },
                        "directorOrAuthor": { "type": "string" },
                        "isOngoing": { "type": "boolean" },
                        "userProgress": { "type": "string" },
                        "userReview": { "type": "string" },
                        "latestUpdateInfo": { "type": "string" },
                        "rating": { "type": "string" }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "remove_item",
                "description": "Remove a media item from the collection by id.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "id": { "type": "string" } },
                    "required": ["id"]
                }
            },
            {
                "name": "get_stats",
                "description": "Collection statistics: totals per category and per media type.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "get_update_reminders",
                "description": "Update-tracking reminders for ongoing works: items flagged with a new update, plus everything still being tracked (ongoing with notifications on). Set only_new=true to see just the flagged ones.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "only_new": { "type": "boolean", "default": false, "description": "Only items with hasNewUpdate=true" }
                    }
                }
            },
            {
                "name": "list_characters",
                "description": "List the user's distilled roleplay characters (persona profiles extracted from collected works).",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "chat_with_character",
                "description": "Send one message to a distilled character and get the in-character reply. The conversation is saved into the app's chat history for that character. Runs through the AI configured in the app; the app window must be open.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "character": { "type": "string", "description": "Character id, name, or alias (case-insensitive)" },
                        "message": { "type": "string" }
                    },
                    "required": ["character", "message"]
                }
            }
        ]
    })
}

// --- Tool execution ---------------------------------------------------------

fn resolve_username(db: &Database) -> String {
    db.get_mcp_config()
        .map(|c| c.username)
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "guest".to_string())
}

async fn call_tool(
    params: &Value,
    db: &Arc<Database>,
    notify: Option<&Arc<NotifyFn>>,
    chat: Option<&Arc<ChatBridge>>,
) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| "missing tool name".to_string())?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let username = resolve_username(db);

    match name {
        "list_items" => {
            let items = db.get_all_for_user(&username)?;
            let category = args.get("category").and_then(|v| v.as_str()).map(str::to_lowercase);
            let kind = args.get("type").and_then(|v| v.as_str()).map(str::to_lowercase);
            let search = args
                .get("search")
                .and_then(|v| v.as_str())
                .map(|s| s.to_lowercase());
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(DEFAULT_LIMIT)
                .clamp(1, MAX_LIMIT);

            let mut filtered: Vec<Value> = items
                .iter()
                .filter(|i| {
                    category
                        .as_ref()
                        .map_or(true, |c| i.category.as_deref().map(str::to_lowercase) == Some(c.clone()))
                })
                .filter(|i| {
                    kind.as_ref()
                        .map_or(true, |k| i.kind.to_lowercase() == *k)
                })
                .filter(|i| {
                    search.as_ref().map_or(true, |s| {
                        i.title.to_lowercase().contains(s)
                            || i.description.to_lowercase().contains(s)
                    })
                })
                .map(|i| serde_json::to_value(i).unwrap_or_default())
                .collect();
            let total = filtered.len();
            filtered.truncate(limit);
            Ok(tool_text(
                json!({ "total": total, "returned": filtered.len(), "items": filtered })
                    .to_string(),
            ))
        }
        "get_item" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let items = db.get_all_for_user(&username)?;
            let item = items
                .iter()
                .find(|i| i.id == id)
                .ok_or_else(|| format!("item '{id}' not found"))?;
            Ok(tool_text(serde_json::to_string_pretty(item).unwrap_or_default()))
        }
        "add_item" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .ok_or("title is required")?;
            let kind = canonicalize(
                args.get("type").and_then(|v| v.as_str()).unwrap_or("Other"),
                &MEDIA_TYPES,
            )
            .ok_or_else(|| format!("invalid type, expected one of {MEDIA_TYPES:?}"))?;
            let category = canonicalize(
                args.get("category")
                    .and_then(|v| v.as_str())
                    .unwrap_or("To Watch"),
                &CATEGORIES,
            )
            .ok_or_else(|| format!("invalid category, expected one of {CATEGORIES:?}"))?;

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let id = format!("mcp-{}-{}", now, next_counter());
            let item = crate::models::MediaItem {
                id: id.clone(),
                title: title.to_string(),
                director_or_author: string_arg(&args, "directorOrAuthor"),
                description: string_arg(&args, "description"),
                release_date: string_arg(&args, "releaseDate"),
                kind,
                is_ongoing: args.get("isOngoing").and_then(|v| v.as_bool()).unwrap_or(false),
                latest_update_info: None,
                category: Some(category),
                saved_at: Some(now),
                poster_url: None,
                rating: optional_string_arg(&args, "rating"),
                cast: None,
                tmdb_id: None,
                tmdb_media_type: None,
                user_progress: None,
                notification_enabled: None,
                last_checked_at: None,
                has_new_update: None,
                user_review: None,
                custom_poster_url: None,
                last_edited_at: Some(now),
                status: None,
                added_at: None,
                user_rating: None,
                parent_collection_id: None,
                is_collection: Some(false),
                is_pinned: None,
            };
            db.add_item_for_user(&username, item.clone())?;
            notify_changed(notify, &username, "add");
            Ok(tool_text(serde_json::to_string_pretty(&item).unwrap_or_default()))
        }
        "update_item" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let items = db.get_all_for_user(&username)?;
            let existing = items
                .iter()
                .find(|i| i.id == id)
                .ok_or_else(|| format!("item '{id}' not found"))?;
            let mut value = serde_json::to_value(existing).map_err(|e| e.to_string())?;
            let patch = args.as_object().ok_or("arguments must be an object")?;
            apply_item_patch(&mut value, patch);
            let updated: crate::models::MediaItem =
                serde_json::from_value(value).map_err(|e| format!("invalid patch: {e}"))?;
            if updated.category.is_some()
                && canonicalize(updated.category.as_deref().unwrap_or(""), &CATEGORIES).is_none()
            {
                return Err(format!("invalid category, expected one of {CATEGORIES:?}"));
            }
            db.add_item_for_user(&username, updated.clone())?;
            notify_changed(notify, &username, "update");
            Ok(tool_text(serde_json::to_string_pretty(&updated).unwrap_or_default()))
        }
        "remove_item" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let items = db.get_all_for_user(&username)?;
            if !items.iter().any(|i| i.id == id) {
                return Err(format!("item '{id}' not found"));
            }
            db.remove_item_for_user(&username, id)?;
            notify_changed(notify, &username, "remove");
            Ok(tool_text(json!({ "removed": id }).to_string()))
        }
        "get_stats" => {
            let items = db.get_all_for_user(&username)?;
            let mut by_category = Map::new();
            for c in CATEGORIES {
                by_category.insert(
                    c.to_string(),
                    json!(items.iter().filter(|i| i.category.as_deref() == Some(c)).count()),
                );
            }
            let mut by_type = Map::new();
            for ty in MEDIA_TYPES {
                by_type.insert(
                    ty.to_string(),
                    json!(items.iter().filter(|i| i.kind == *ty).count()),
                );
            }
            Ok(tool_text(
                json!({
                    "user": username,
                    "total": items.len(),
                    "byCategory": by_category,
                    "byType": by_type
                })
                .to_string(),
            ))
        }
        "get_update_reminders" => {
            let only_new = args
                .get("only_new")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let items = db.get_all_for_user(&username)?;
            // Same tracking semantics as the app's own update checker:
            // ongoing works with notifications not explicitly disabled, plus
            // anything already flagged as having a new update.
            let reminders: Vec<Value> = items
                .iter()
                .filter(|i| {
                    let flagged = i.has_new_update == Some(true);
                    if only_new {
                        return flagged;
                    }
                    flagged || (i.is_ongoing && i.notification_enabled != Some(false))
                })
                .map(|i| {
                    json!({
                        "id": i.id,
                        "title": i.title,
                        "type": i.kind,
                        "latestUpdateInfo": i.latest_update_info,
                        "isOngoing": i.is_ongoing,
                        "hasNewUpdate": i.has_new_update,
                        "lastCheckedAt": i.last_checked_at,
                        "userProgress": i.user_progress
                    })
                })
                .collect();
            Ok(tool_text(
                json!({ "total": reminders.len(), "reminders": reminders }).to_string(),
            ))
        }
        "list_characters" => {
            let characters = db.get_characters_for_user(&username)?;
            let out: Vec<Value> = characters
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "name": c.name,
                        "aliases": c.aliases,
                        "sourceTitle": c.source_title,
                        "tagline": c.tagline,
                        "personality": c.personality,
                        "version": c.version
                    })
                })
                .collect();
            Ok(tool_text(
                json!({ "total": out.len(), "characters": out }).to_string(),
            ))
        }
        "chat_with_character" => {
            let target = args
                .get("character")
                .and_then(|v| v.as_str())
                .ok_or("missing character (id, name, or alias)")?;
            let message = args
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .ok_or("missing message")?;
            let characters = db.get_characters_for_user(&username)?;
            let lower = target.to_lowercase();
            let found = characters
                .iter()
                .find(|c| c.id == target)
                .or_else(|| characters.iter().find(|c| c.name.to_lowercase() == lower))
                .or_else(|| {
                    characters
                        .iter()
                        .find(|c| c.aliases.iter().any(|a| a.to_lowercase() == lower))
                })
                .ok_or_else(|| {
                    format!("character '{target}' not found — call list_characters for available ids")
                })?;
            let bridge = chat.ok_or(
                "character chat requires the running app window (it uses the AI key configured there)",
            )?;
            let reply = bridge(found.id.clone(), message.to_string()).await?;
            notify_changed(notify, &username, "chat");
            Ok(tool_text(json!({ "character": found.name, "reply": reply }).to_string()))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

/// Merge a patch object into the item's JSON value in place. `id` is frozen
/// and explicit nulls are skipped so agents can't blank fields by accident.
pub fn apply_item_patch(item: &mut Value, patch: &serde_json::Map<String, Value>) {
    if let Some(obj) = item.as_object_mut() {
        for (key, val) in patch {
            if key == "id" || val.is_null() {
                continue;
            }
            obj.insert(key.clone(), val.clone());
        }
        if let Some(now) = now_millis() {
            obj.insert("lastEditedAt".to_string(), json!(now));
        }
    }
}

fn now_millis() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

static COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_counter() -> u64 {
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn canonicalize(input: &str, allowed: &[&str]) -> Option<String> {
    allowed
        .iter()
        .find(|a| a.eq_ignore_ascii_case(input.trim()))
        .map(|a| a.to_string())
}

fn string_arg(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn optional_string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn notify_changed(notify: Option<&Arc<NotifyFn>>, username: &str, action: &str) {
    if let Some(cb) = notify {
        cb(username, action);
    }
}
