use std::fs;
use std::path::PathBuf;
use base64::Engine as _;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use crate::models::{MediaItem, DistilledCharacter, ChatSession, CollectionData, UserRecord, AIConfig, ThemeConfig, McpConfig};
use std::sync::Mutex;

pub struct Database {
    path: PathBuf,
    cache: Mutex<CollectionData>,
}

/// Outcome of merging a peer's items, surfaced to the user after a sync.
/// `updated` counts whole-item replacements where the peer's edit was strictly
/// newer — those are the merges that can discard local field-level changes.
#[derive(Debug, Clone, Serialize)]
pub struct MergeSummary {
    pub added: u64,
    pub updated: u64,
}

/// Whether an incoming synced poster file may replace the local cache copy.
/// Rendering priority is custom poster > local file > remote URL, so a stale
/// local file would keep masking a newer remote URL; overwrite only when the
/// peer demonstrably cached the artwork later (or we have nothing yet).
/// A peer that predates poster timestamps (peer_at = None) keeps the old
/// always-overwrite behavior so older app versions still propagate artwork.
pub fn should_overwrite_poster(local_at: Option<u64>, peer_at: Option<u64>, has_local_file: bool) -> bool {
    if !has_local_file {
        return true;
    }
    match peer_at {
        None => true,
        Some(peer) => peer > local_at.unwrap_or(0),
    }
}

impl Database {
    pub fn new(app_handle: &AppHandle) -> Self {
        let app_dir = app_handle.path().app_data_dir().expect("Failed to get app data dir");
        if !app_dir.exists() {
            fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
        }
        let path = app_dir.join("collection.json");
        
        let data = if path.exists() {
            let content = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            CollectionData::default()
        };

        Database {
            path,
            cache: Mutex::new(data),
        }
    }

    /// Test-only constructor that skips the Tauri AppHandle.
    #[cfg(test)]
    pub fn new_at_path(path: PathBuf) -> Self {
        let data = if path.exists() {
            let content = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            CollectionData::default()
        };

        Database {
            path,
            cache: Mutex::new(data),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let data = self.cache.lock().map_err(|e| e.to_string())?;
        let content = serde_json::to_string_pretty(&*data).map_err(|e| e.to_string())?;
        fs::write(&self.path, content).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn get_all(&self) -> Result<Vec<MediaItem>, String> {
        let data = self.cache.lock().map_err(|e| e.to_string())?;
        Ok(data.items.clone())
    }

    pub fn get_all_for_user(&self, username: &str) -> Result<Vec<MediaItem>, String> {
        let data = self.cache.lock().map_err(|e| e.to_string())?;
        Ok(data.items_by_user.get(username).cloned().unwrap_or_default())
    }

    pub fn add_item_for_user(&self, username: &str, item: MediaItem) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        let list = data.items_by_user.entry(username.to_string()).or_default();
        // Upsert: re-saving an item must keep its position (order changes only
        // come from reorder_collection); only brand-new items go to the front.
        match list.iter().position(|i| i.id == item.id) {
            Some(idx) => list[idx] = item,
            None => list.insert(0, item),
        }
        drop(data);
        self.save()
    }

    pub fn reorder_items_for_user(&self, username: &str, new_order_ids: Vec<String>) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some(list) = data.items_by_user.get_mut(username) {
            let mut id_map: std::collections::HashMap<String, MediaItem> = list.drain(..).map(|item| (item.id.clone(), item)).collect();
            let mut new_list = Vec::new();
            
            for id in new_order_ids {
                if let Some(item) = id_map.remove(&id) {
                    new_list.push(item);
                }
            }
            
            // Append any remaining items that were not in new_order_ids (just in case)
            // Ideally this shouldn't happen if the frontend sends all IDs, but safety first.
            // Or maybe we should put them at the end?
            // If the user drags items, they should be sending the full list of IDs.
            // If some are missing, they might get deleted if we don't handle them.
            // Let's assume new_order_ids is the FULL list.
            // But if id_map is not empty, it means some items were missed. We should add them back.
            // However, since we used a HashMap, the order is lost for remaining items.
            // Let's re-iterate the original list? No, we drained it.
            // Let's just append remaining items.
             for (_, item) in id_map {
                new_list.push(item);
            }
            
            *list = new_list;
        }
        drop(data);
        self.save()
    }


    pub fn remove_item_for_user(&self, username: &str, id: &str) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some(list) = data.items_by_user.get_mut(username) {
            list.retain(|i| i.id != id);
        }
        drop(data);
        self.save()
    }

    /// Return only a single user's collection for LAN sync, so credentials,
    /// configs, and other users' data are never exposed to peers.
    pub fn get_user_items(&self, username: &str) -> Result<Vec<MediaItem>, String> {
        self.get_all_for_user(username)
    }

    /// Merge remote collection items for a single user.
    /// Users, configs, and sync tokens are intentionally not merged: LAN sync is
    /// scoped to collection data, not credentials or settings.
    pub fn merge_user_items(&self, username: &str, incoming_items: Vec<MediaItem>) -> Result<MergeSummary, String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;

        let local_items = data.items_by_user.entry(username.to_string()).or_default();
        let mut summary = MergeSummary { added: 0, updated: 0 };
        for item in incoming_items {
            if let Some(existing_idx) = local_items.iter().position(|i| i.id == item.id) {
                let existing = &local_items[existing_idx];
                let incoming_ts = item.last_edited_at.unwrap_or(0);
                let existing_ts = existing.last_edited_at.unwrap_or(0);
                if incoming_ts > existing_ts {
                    local_items[existing_idx] = item;
                    summary.updated += 1;
                }
            } else {
                local_items.push(item);
                summary.added += 1;
            }
        }

        drop(data);
        self.save()?;
        Ok(summary)
    }

    pub fn get_sync_token(&self) -> String {
        match self.cache.lock() {
            Ok(data) => data.sync_token.clone(),
            Err(_) => String::new(),
        }
    }

    pub fn set_sync_token(&self, token: String) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        data.sync_token = token;
        drop(data);
        self.save()
    }
    
    pub fn save_configs(&self, ai_config: Option<AIConfig>, theme_config: Option<ThemeConfig>) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some(config) = ai_config {
            data.ai_config = Some(config);
        }
        if let Some(config) = theme_config {
            data.theme_config = Some(config);
        }
        drop(data);
        self.save()
    }

    pub fn get_configs(&self) -> Result<(Option<AIConfig>, Option<ThemeConfig>), String> {
        let data = self.cache.lock().map_err(|e| e.to_string())?;
        Ok((data.ai_config.clone(), data.theme_config.clone()))
    }

    pub fn get_mcp_config(&self) -> Option<McpConfig> {
        self.cache.lock().ok().and_then(|d| d.mcp_config.clone())
    }

    pub fn set_mcp_config(&self, config: McpConfig) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        data.mcp_config = Some(config);
        drop(data);
        self.save()
    }
    
    #[allow(dead_code)]
    pub fn update_item(&self, _item: MediaItem) -> Result<(), String> {
        Err("update_item deprecated; use per-user methods".to_string())
    }
    
    // Bulk import
    pub fn import_for_user(&self, username: &str, items: Vec<MediaItem>) -> Result<(), String> {
         let mut data = self.cache.lock().map_err(|e| e.to_string())?;
         let list = data.items_by_user.entry(username.to_string()).or_default();
         let existing_ids: Vec<String> = list.iter().map(|i| i.id.clone()).collect();
         for item in items {
             if !existing_ids.contains(&item.id) {
                 list.push(item);
             }
         }
         drop(data);
         self.save()
    }

    // --- Auth helpers ---
    pub fn find_user(&self, username: &str) -> Option<UserRecord> {
        let data = self.cache.lock().ok()?;
        data.users.iter().find(|u| u.username == username).cloned()
    }

    // --- Distilled characters ---
    pub fn get_characters_for_user(&self, username: &str) -> Result<Vec<DistilledCharacter>, String> {
        let data = self.cache.lock().map_err(|e| e.to_string())?;
        Ok(data.characters_by_user.get(username).cloned().unwrap_or_default())
    }

    pub fn upsert_character_for_user(&self, username: &str, character: DistilledCharacter) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        let list = data.characters_by_user.entry(username.to_string()).or_default();
        match list.iter().position(|c| c.id == character.id) {
            Some(idx) => list[idx] = character,
            None => list.insert(0, character),
        }
        drop(data);
        self.save()
    }

    /// Remove a character and cascade-delete its chat sessions.
    pub fn remove_character_for_user(&self, username: &str, id: &str) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some(list) = data.characters_by_user.get_mut(username) {
            list.retain(|c| c.id != id);
        }
        if let Some(list) = data.chat_sessions_by_user.get_mut(username) {
            list.retain(|s| s.character_id != id);
        }
        drop(data);
        self.save()
    }

    /// Merge remotely synced characters: same id keeps the higher `version`
    /// (bumped on every re-distillation / correction), unknown ids are added.
    pub fn merge_characters_for_user(&self, username: &str, incoming: Vec<DistilledCharacter>) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        let list = data.characters_by_user.entry(username.to_string()).or_default();
        for character in incoming {
            match list.iter_mut().find(|c| c.id == character.id) {
                Some(existing) => {
                    if character.version > existing.version {
                        *existing = character;
                    }
                }
                None => list.insert(0, character),
            }
        }
        drop(data);
        self.save()
    }

    /// Merge remotely synced chat sessions: same id keeps the newer
    /// `updated_at`, unknown ids are added.
    pub fn merge_chat_sessions_for_user(&self, username: &str, incoming: Vec<ChatSession>) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        let list = data.chat_sessions_by_user.entry(username.to_string()).or_default();
        for session in incoming {
            match list.iter_mut().find(|s| s.id == session.id) {
                Some(existing) => {
                    if session.updated_at > existing.updated_at {
                        *existing = session;
                    }
                }
                None => list.insert(0, session),
            }
        }
        drop(data);
        self.save()
    }

    /// Rescue pass for users upgrading from the pre-login era: everything
    /// tracked without an account landed in the shared "guest" bucket. Merge
    /// it into the freshly authenticated account (dedup by id, chat sessions
    /// keep the newer copy) and drop the bucket so the shared data can never
    /// leak into a different account created later on the same device.
    pub fn migrate_guest_data(&self, username: &str) -> Result<usize, String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        let mut moved = 0usize;

        if let Some(guest_items) = data.items_by_user.remove("guest") {
            moved += guest_items.len();
            let list = data.items_by_user.entry(username.to_string()).or_default();
            for item in guest_items {
                if !list.iter().any(|i| i.id == item.id) {
                    list.push(item);
                }
            }
        }

        if let Some(guest_chars) = data.characters_by_user.remove("guest") {
            moved += guest_chars.len();
            let list = data.characters_by_user.entry(username.to_string()).or_default();
            for c in guest_chars {
                if !list.iter().any(|i| i.id == c.id) {
                    list.push(c);
                }
            }
        }

        if let Some(guest_sessions) = data.chat_sessions_by_user.remove("guest") {
            moved += guest_sessions.len();
            let list = data.chat_sessions_by_user.entry(username.to_string()).or_default();
            for session in guest_sessions {
                match list.iter_mut().find(|s| s.id == session.id) {
                    Some(existing) => {
                        if session.updated_at > existing.updated_at {
                            *existing = session;
                        }
                    }
                    None => list.insert(0, session),
                }
            }
        }

        if moved > 0 {
            drop(data);
            self.save()?;
        }
        Ok(moved)
    }

    // --- Character chat sessions ---
    pub fn get_chat_sessions_for_user(&self, username: &str) -> Result<Vec<ChatSession>, String> {
        let data = self.cache.lock().map_err(|e| e.to_string())?;
        Ok(data.chat_sessions_by_user.get(username).cloned().unwrap_or_default())
    }

    pub fn upsert_chat_session_for_user(&self, username: &str, session: ChatSession) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        let list = data.chat_sessions_by_user.entry(username.to_string()).or_default();
        match list.iter().position(|s| s.id == session.id) {
            Some(idx) => list[idx] = session,
            None => list.insert(0, session),
        }
        drop(data);
        self.save()
    }

    pub fn remove_chat_session_for_user(&self, username: &str, id: &str) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some(list) = data.chat_sessions_by_user.get_mut(username) {
            list.retain(|s| s.id != id);
        }
        drop(data);
        self.save()
    }

    pub fn add_user(&self, user: UserRecord) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        if data.users.iter().any(|u| u.username == user.username) {
            return Err("User already exists".to_string());
        }
        data.users.push(user);
        drop(data);
        self.save()
    }

    /// Replace a local account's password hash (forgot-password reset).
    /// Collection data is untouched; only the auth record changes.
    pub fn update_user_password(&self, username: &str, password_hash: String) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        match data.users.iter_mut().find(|u| u.username == username) {
            Some(user) => user.password_hash = password_hash,
            None => return Err("USER_NOT_FOUND".to_string()),
        }
        drop(data);
        self.save()
    }

    fn posters_dir(&self) -> PathBuf {
        self.path.parent().map(|p| p.join("posters")).unwrap_or_else(|| PathBuf::from("posters"))
    }

    /// Local poster cache: one file per item id, bytes sniffed for the mime on
    /// read so the webview can render them as data URIs without network.
    pub fn save_poster_data(&self, id: &str, data_uri: &str) -> Result<(), String> {
        let id = sanitize_poster_id(id);
        if id.is_empty() { return Err("INVALID_POSTER_ID".to_string()); }
        let (mime, b64) = data_uri
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(";base64,"))
            .ok_or("INVALID_DATA_URI")?;
        if !mime.starts_with("image/") { return Err("INVALID_DATA_URI".to_string()); }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())?;
        if bytes.len() < 256 { return Err("POSTER_TOO_SMALL".to_string()); }
        let dir = self.posters_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{id}.img")), bytes).map_err(|e| e.to_string())
    }

    pub fn read_poster_file(&self, id: &str) -> Result<Option<(Vec<u8>, String)>, String> {
        let id = sanitize_poster_id(id);
        if id.is_empty() { return Ok(None); }
        let file = self.posters_dir().join(format!("{id}.img"));
        if !file.exists() { return Ok(None); }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        let mime = sniff_mime(&bytes).to_string();
        Ok(Some((bytes, mime)))
    }

    /// Whether a local cache file exists for the item id (existence check only,
    /// no bytes read).
    pub fn poster_file_exists(&self, id: &str) -> bool {
        let id = sanitize_poster_id(id);
        if id.is_empty() { return false; }
        self.posters_dir().join(format!("{id}.img")).exists()
    }

    /// Pre-merge snapshot of the local artwork vintage for the given item ids.
    /// The poster files on disk correspond to the pre-merge item state, so the
    /// overwrite comparison must read this before `merge_user_items` applies
    /// the peer's item versions (which carry the peer's posterLocalAt).
    pub fn get_items_poster_local_at(&self, username: &str, ids: &[String]) -> Vec<(String, u64)> {
        let Ok(data) = self.cache.lock() else { return Vec::new() };
        let Some(items) = data.items_by_user.get(username) else { return Vec::new() };
        items.iter()
            .filter(|i| ids.contains(&i.id))
            .filter_map(|i| i.poster_local_at.map(|at| (i.id.clone(), at)))
            .collect()
    }

    /// Record the artwork vintage of the local cache file, but never step
    /// backwards: the stored timestamp must always describe the newest file
    /// this device has had for the item.
    pub fn set_poster_local_at_if_newer(&self, username: &str, id: &str, at: u64) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some(items) = data.items_by_user.get_mut(username) {
            if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                if item.poster_local_at.unwrap_or(0) < at {
                    item.poster_local_at = Some(at);
                }
            }
        }
        drop(data);
        self.save()
    }

    /// Posters for every item the user owns, as `id → data URI`. The sync
    /// endpoint embeds this in its payload so peers receive the actual images,
    /// not just the (possibly decayed or unreachable) remote URLs.
    pub fn get_poster_b64_map(&self, username: &str) -> Result<Vec<(String, String)>, String> {
        use base64::Engine as _;
        let mut out = Vec::new();
        for item in self.get_user_items(username)? {
            if let Some((bytes, mime)) = self.read_poster_file(&item.id)? {
                out.push((item.id, format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))));
            }
        }
        Ok(out)
    }
}

fn sanitize_poster_id(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect()
}

pub fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        "image/jpeg"
    }
}
