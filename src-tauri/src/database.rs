use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;
use crate::models::{MediaItem, DistilledCharacter, ChatSession, CollectionData, UserRecord, AIConfig, ThemeConfig, McpConfig};
use std::sync::Mutex;

pub struct Database {
    path: PathBuf,
    cache: Mutex<CollectionData>,
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
    pub fn merge_user_items(&self, username: &str, incoming_items: Vec<MediaItem>) -> Result<(), String> {
        let mut data = self.cache.lock().map_err(|e| e.to_string())?;

        let local_items = data.items_by_user.entry(username.to_string()).or_default();
        for item in incoming_items {
            if let Some(existing_idx) = local_items.iter().position(|i| i.id == item.id) {
                let existing = &local_items[existing_idx];
                let incoming_ts = item.last_edited_at.unwrap_or(0);
                let existing_ts = existing.last_edited_at.unwrap_or(0);
                if incoming_ts > existing_ts {
                    local_items[existing_idx] = item;
                }
            } else {
                local_items.push(item);
            }
        }

        drop(data);
        self.save()
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
}
