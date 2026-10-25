#[cfg(test)]
mod tests {
    // Removed unused imports and tempfile dependency
}

#[test]
fn test_media_item_serialization() {
    let item = crate::models::MediaItem {
        id: "123".to_string(),
        title: "Test Movie".to_string(),
        director_or_author: "Director".to_string(),
        description: "Desc".to_string(),
        release_date: "2024".to_string(),
        kind: "Movie".to_string(),
        is_ongoing: false,
        latest_update_info: None,
        category: None,
        saved_at: None,
        poster_url: None,
        rating: None,
        cast: None,
        tmdb_id: None,
        tmdb_media_type: None,
        user_progress: None,
        notification_enabled: None,
        last_checked_at: None,
        has_new_update: None,
        user_review: None,
        custom_poster_url: None,
        last_edited_at: None,
        status: None,
        added_at: None,
        user_rating: None,
        parent_collection_id: None,
        is_collection: None,
        is_pinned: Some(true),
    };

    let json = serde_json::to_string(&item).unwrap();
    assert!(json.contains("\"title\":\"Test Movie\""));
    assert!(json.contains("\"type\":\"Movie\""));
    assert!(json.contains("\"isPinned\":true"));
}

#[test]
fn test_duckduckgo_parsing() {
    let html = r#"
    <!DOCTYPE html>
    <html>
    <body>
        <div class="result results_links_deep highlight_d">
            <div class="result__body">
                <h2 class="result__title">
                    <a class="result__a" href="https://example.com/movie">Test Movie (2024)</a>
                </h2>
                <div class="result__snippet">This is a description of the test movie.</div>
            </div>
        </div>
        <div class="result results_links_deep highlight_d">
            <div class="result__body">
                <h2 class="result__title">
                    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fother.com%2Ffoo">Redirected Link</a>
                </h2>
                <div class="result__snippet">Redirect test</div>
            </div>
        </div>
    </body>
    </html>
    "#;

    let results = crate::parse_duckduckgo_response_body(html);
    
    assert_eq!(results.len(), 2);
    
    assert_eq!(results[0].title, "Test Movie (2024)");
    assert_eq!(results[0].link, "https://example.com/movie");
    assert_eq!(results[0].snippet, "This is a description of the test movie.");
    
    // Check uddg decoding
    assert_eq!(results[1].title, "Redirected Link");
    assert_eq!(results[1].link, "https://other.com/foo"); 
}

#[test]
fn test_distilled_character_serialization() {
    use crate::models::{CharacterCorrection, DistilledCharacter, ExpressionDNA};

    let character = DistilledCharacter {
        id: "char-1".to_string(),
        name: "Sherlock".to_string(),
        aliases: vec!["Holmes".to_string()],
        source_title: "A Study in Scarlet".to_string(),
        source_media_id: Some("media-9".to_string()),
        source_type: Some("Book".to_string()),
        tagline: Some("Consulting detective".to_string()),
        appearance: None,
        personality: vec!["observant".to_string()],
        mental_models: vec!["deduction first".to_string()],
        decision_heuristics: vec![],
        interpersonal: None,
        boundaries: vec![],
        background: None,
        expression: Some(ExpressionDNA {
            tone: Some("sharp".to_string()),
            formality: 3,
            catchphrases: vec!["Elementary".to_string()],
            vocabulary: vec![],
            sentence_style: None,
            example_lines: vec!["When you have eliminated the impossible...".to_string()],
        }),
        relationships: vec![],
        quotes: vec!["Data! Data! Data!".to_string()],
        external_views: vec![],
        timeline: vec![],
        corrections: vec![CharacterCorrection {
            scene: "greeting a client".to_string(),
            wrong: "coldly ignores them".to_string(),
            correct: "politely asks for details".to_string(),
            created_at: 100.0,
        }],
        version: 2,
        avatar_url: None,
        greeting: Some("The game is afoot!".to_string()),
        created_at: 1.0,
        updated_at: 2.0,
    };

    let json = serde_json::to_string(&character).unwrap();
    assert!(json.contains("\"sourceTitle\":\"A Study in Scarlet\""));
    assert!(json.contains("\"mentalModels\":[\"deduction first\"]"));
    assert!(json.contains("\"sentenceStyle\":null"));
    assert!(json.contains("\"createdAt\":100.0"));

    // Round-trip: missing optional/default fields must deserialize cleanly
    // (older frontend payloads / hand-written JSON).
    let minimal: DistilledCharacter = serde_json::from_str(
        r#"{"id":"c2","name":"Rin","sourceTitle":"Fate","createdAt":1.0,"updatedAt":1.0}"#,
    )
    .unwrap();
    assert_eq!(minimal.version, 0);
    assert!(minimal.aliases.is_empty());
    assert!(minimal.corrections.is_empty());
    assert!(minimal.expression.is_none());
}

#[test]
fn test_chat_session_serialization() {
    use crate::models::{ChatMessage, ChatSession};

    let session = ChatSession {
        id: "s-1".to_string(),
        character_id: "char-1".to_string(),
        title: "First talk".to_string(),
        summary: Some("Earlier they discussed the case.".to_string()),
        summarized_up_to: 4,
        messages: vec![ChatMessage {
            id: "m-1".to_string(),
            role: "user".to_string(),
            content: "Hello".to_string(),
            created_at: 5.0,
        }],
        created_at: 1.0,
        updated_at: 6.0,
    };

    let json = serde_json::to_string(&session).unwrap();
    assert!(json.contains("\"characterId\":\"char-1\""));
    assert!(json.contains("\"summarizedUpTo\":4"));

    let parsed: ChatSession = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.messages.len(), 1);
    assert_eq!(parsed.summarized_up_to, 4);

    // Minimal payload without optional fields (summary/messages default).
    let minimal: ChatSession = serde_json::from_str(
        r#"{"id":"s2","characterId":"c","title":"t","createdAt":1.0,"updatedAt":1.0}"#,
    )
    .unwrap();
    assert!(minimal.messages.is_empty());
    assert_eq!(minimal.summarized_up_to, 0);
}

#[test]
fn test_split_search_keys() {
    // The UI advertises multi-key search credentials separated by ; or ；.
    assert_eq!(
        crate::split_search_keys(Some("key-a; key-b； key-c ;; ")),
        vec!["key-a".to_string(), "key-b".to_string(), "key-c".to_string()]
    );
    assert!(crate::split_search_keys(None).is_empty());
    assert!(crate::split_search_keys(Some("   ")).is_empty());
    assert_eq!(
        crate::split_search_keys(Some("single")),
        vec!["single".to_string()]
    );
}

#[tokio::test]
async fn test_search_with_key_rotation() {
    let item = || crate::SearchResultItem {
        title: "t".to_string(),
        snippet: "s".to_string(),
        link: "https://example.com".to_string(),
        image: None,
        metadata: None,
    };

    // A rejected key rotates to the next one instead of failing the search.
    let items = crate::search_with_key_rotation(
        vec!["rejected".to_string(), "accepted".to_string()],
        |key| async move {
            if key == "accepted" {
                Ok(vec![item()])
            } else {
                Err("API key not valid".to_string())
            }
        },
    )
    .await
    .expect("second key should be used");
    assert_eq!(items.len(), 1);

    // Every key rejected -> the provider's error is surfaced.
    let err = crate::search_with_key_rotation(vec!["a".to_string()], |_key| async move {
        Err::<Vec<crate::SearchResultItem>, String>("quota".to_string())
    })
    .await
    .expect_err("all keys failed");
    assert_eq!(err, "quota");

    // An accepted-but-empty response outranks a later key's error.
    let items = crate::search_with_key_rotation(
        vec!["empty".to_string(), "rejected".to_string()],
        |key| async move {
            if key == "empty" {
                Ok(Vec::new())
            } else {
                Err("boom".to_string())
            }
        },
    )
    .await
    .expect("accepted key wins");
    assert!(items.is_empty());
}

#[test]
fn test_ai_timeouts_allow_reasoning_models() {
    // Reasoning models can think for minutes before the first byte, so the AI
    // request budget must stay well above the old 120 s that killed desktop
    // replies (and distillations) while the browser build succeeded.
    assert!(
        crate::AI_TOTAL_TIMEOUT_SECS >= 300,
        "AI total timeout is {}s — reasoning-model replies need several minutes",
        crate::AI_TOTAL_TIMEOUT_SECS
    );
    assert!(crate::AI_READ_TIMEOUT_SECS >= 60, "per-read guard must still catch stalls");
    assert!(
        crate::AI_READ_TIMEOUT_SECS <= crate::AI_TOTAL_TIMEOUT_SECS,
        "the per-read guard cannot exceed the total budget"
    );
    assert!(crate::AI_CONNECT_TIMEOUT_SECS <= 60, "connects should fail fast");
}

fn make_db_item(id: &str, title: &str) -> crate::models::MediaItem {
    crate::models::MediaItem {
        id: id.to_string(),
        title: title.to_string(),
        director_or_author: String::new(),
        description: String::new(),
        release_date: String::new(),
        kind: "TV Series".to_string(),
        is_ongoing: false,
        latest_update_info: None,
        category: None,
        saved_at: None,
        poster_url: None,
        rating: None,
        cast: None,
        tmdb_id: None,
        tmdb_media_type: None,
        user_progress: None,
        notification_enabled: None,
        last_checked_at: None,
        has_new_update: None,
        user_review: None,
        custom_poster_url: None,
        last_edited_at: None,
        status: None,
        added_at: None,
        user_rating: None,
        parent_collection_id: None,
        is_collection: None,
        is_pinned: None,
    }
}

#[test]
fn test_add_item_for_user_new_items_go_to_front() {
    let path = std::env::temp_dir().join(format!("mediatracker_test_add_new_{}.json", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let db = crate::database::Database::new_at_path(path.clone());

    db.add_item_for_user("alice", make_db_item("a", "Season 1")).unwrap();
    db.add_item_for_user("alice", make_db_item("b", "Season 2")).unwrap();

    let items = db.get_all_for_user("alice").unwrap();
    let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["b", "a"], "newly added items must land at the front");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn test_add_item_for_user_resave_keeps_position() {
    let path = std::env::temp_dir().join(format!("mediatracker_test_resave_{}.json", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let db = crate::database::Database::new_at_path(path.clone());

    db.add_item_for_user("alice", make_db_item("a", "Slow Horses")).unwrap();
    db.add_item_for_user("alice", make_db_item("b", "Other show")).unwrap();
    db.add_item_for_user("alice", make_db_item("c", "Third show")).unwrap();

    // Re-saving the oldest item (e.g. a merged season update) is a data-only
    // save: the user's ordering must not be reshuffled. The pre-fix behavior
    // pulled it to the front like a brand-new item.
    let mut updated = make_db_item("a", "Slow Horses S6");
    updated.is_collection = Some(true);
    db.add_item_for_user("alice", updated).unwrap();

    let items = db.get_all_for_user("alice").unwrap();
    let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["c", "b", "a"], "re-saving an item must keep its position");
    assert_eq!(items[2].title, "Slow Horses S6", "the save must still update the data");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn test_mcp_tools_list_contains_expected_tools() {
    let list = crate::mcp::build_tools_list();
    let tools = list["tools"].as_array().expect("tools array");
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    for expected in [
        "list_items", "get_item", "add_item", "update_item", "remove_item", "get_stats",
        "get_update_reminders", "list_characters", "chat_with_character",
    ] {
        assert!(names.contains(&expected), "missing MCP tool: {expected}");
    }
    // Every tool must declare a JSON Schema for its inputs.
    for t in tools {
        assert!(t["inputSchema"]["type"].is_string(), "tool {:?} lacks inputSchema", t["name"]);
    }
}

#[test]
fn test_mcp_apply_item_patch_merges_and_freezes_id() {
    let mut item = serde_json::json!({
        "id": "abc",
        "title": "Old Title",
        "description": "keep",
        "userProgress": "S1E3"
    });
    let patch: serde_json::Map<String, serde_json::Value> = serde_json::json!({
        "id": "hacked",
        "title": "New Title",
        "description": null,
        "userProgress": "S2E1"
    })
    .as_object()
    .unwrap()
    .clone();

    crate::mcp::apply_item_patch(&mut item, &patch);

    assert_eq!(item["id"], "abc", "id must not be changeable via patch");
    assert_eq!(item["title"], "New Title");
    assert_eq!(item["userProgress"], "S2E1");
    assert_eq!(item["description"], "keep", "explicit nulls are skipped, not applied");
    assert!(item["lastEditedAt"].is_u64(), "patch must stamp lastEditedAt");
}

#[tokio::test]
async fn test_mcp_http_protocol_roundtrip() {
    use serde_json::json;

    let path = std::env::temp_dir().join(format!("mediatracker_test_mcp_{}.json", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let db = std::sync::Arc::new(crate::database::Database::new_at_path(path.clone()));
    db.set_mcp_config(crate::models::McpConfig { enabled: true, port: 8787, username: "guest".into() }).unwrap();
    db.add_item_for_user("guest", make_db_item("existing-1", "Slow Horses")).unwrap();

    // Update-reminder seeds: A = flagged new update, B = tracked ongoing,
    // C = ongoing but notifications off, D = finished (never a reminder).
    let mut a = make_db_item("rem-a", "Show A");
    a.is_ongoing = true;
    a.has_new_update = Some(true);
    let mut b = make_db_item("rem-b", "Show B");
    b.is_ongoing = true;
    let mut c = make_db_item("rem-c", "Show C");
    c.is_ongoing = true;
    c.notification_enabled = Some(false);
    let d = make_db_item("rem-d", "Show D");
    for item in [a, b, c, d] {
        db.add_item_for_user("guest", item).unwrap();
    }

    // Character seeds for the chat tool.
    let hero = crate::models::DistilledCharacter {
        id: "char-1".into(),
        name: "River Cartwright".into(),
        aliases: vec!["River".into()],
        source_title: "Slow Horses".into(),
        source_media_id: None,
        source_type: Some("TV Series".into()),
        tagline: Some("Lost cause in MI5".into()),
        appearance: None,
        personality: vec!["stubborn".into()],
        mental_models: vec![],
        decision_heuristics: vec![],
        interpersonal: None,
        boundaries: vec![],
        background: None,
        expression: None,
        relationships: vec![],
        quotes: vec![],
        external_views: vec![],
        timeline: vec![],
        corrections: vec![],
        version: 1,
        avatar_url: None,
        greeting: None,
        created_at: 0.0,
        updated_at: 0.0,
    };
    db.upsert_character_for_user("guest", hero).unwrap();

    // Real socket on an OS-assigned port — the same bind/serve path the app
    // uses in production, exercised through an actual HTTP client.
    let chat: std::sync::Arc<crate::mcp::ChatBridge> = std::sync::Arc::new(
        |cid: String, msg: String| -> crate::mcp::ChatFuture {
            Box::pin(async move { Ok(format!("echo:{cid}:{msg}")) })
        },
    );
    let (listener, port) = crate::mcp::bind_listener(0).await.expect("bind");
    let router = crate::mcp::build_router_for_test(db.clone(), Some(chat));
    tokio::spawn(crate::mcp::serve_listener(listener, router));
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::new();

    // initialize echoes the client's protocol version.
    let v: serde_json::Value = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {} }
        }))
        .send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(v["result"]["serverInfo"]["name"], "mediatrove");

    // Notifications (no id) are accepted with 202 and no body.
    let res = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .send().await.unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::ACCEPTED);

    let call = |name: &str, args: serde_json::Value| {
        json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": name, "arguments": args }
        })
    };

    // tools/call: list_items returns the seeded item.
    let v: serde_json::Value = client
        .post(&url)
        .json(&call("list_items", json!({ "search": "slow horses" })))
        .send().await.unwrap()
        .json().await.unwrap();
    let text = v["result"]["content"][0]["text"].as_str().unwrap();
    let payload: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(payload["total"], 1, "search should match the seeded item");

    // tools/call: add_item persists through the shared Database.
    let v: serde_json::Value = client
        .post(&url)
        .json(&call("add_item", json!({
            "title": "Test Movie", "type": "movie", "category": "watched"
        })))
        .send().await.unwrap()
        .json().await.unwrap();
    assert!(v["result"].get("isError").is_none(), "add_item should succeed");
    let items = db.get_all_for_user("guest").unwrap();
    assert_eq!(items.len(), 6, "existing-1 + 4 reminder seeds + the new item");
    let added = items.iter().find(|i| i.title == "Test Movie").expect("item persisted");
    // Type/category inputs are case-insensitive and canonicalized.
    assert_eq!(added.kind, "Movie");
    assert_eq!(added.category.as_deref(), Some("Watched"));

    // get_update_reminders: flagged + tracked ongoing, excluding opted-out
    // and finished works; only_new narrows to the flagged one.
    let parse_text = |v: serde_json::Value| -> serde_json::Value {
        let text = v["result"]["content"][0]["text"].as_str().unwrap().to_string();
        serde_json::from_str(&text).unwrap()
    };
    let v: serde_json::Value = client
        .post(&url)
        .json(&call("get_update_reminders", json!({})))
        .send().await.unwrap()
        .json().await.unwrap();
    let payload = parse_text(v);
    let titles: Vec<&str> = payload["reminders"].as_array().unwrap()
        .iter().map(|r| r["title"].as_str().unwrap()).collect();
    assert_eq!(titles, vec!["Show B", "Show A"], "tracked = flagged(A) + ongoing(B); C opted out, D finished");

    let v: serde_json::Value = client
        .post(&url)
        .json(&call("get_update_reminders", json!({ "only_new": true })))
        .send().await.unwrap()
        .json().await.unwrap();
    let payload = parse_text(v);
    assert_eq!(payload["total"], 1);
    assert_eq!(payload["reminders"][0]["hasNewUpdate"], true);

    // list_characters exposes the distilled persona.
    let v: serde_json::Value = client
        .post(&url)
        .json(&call("list_characters", json!({})))
        .send().await.unwrap()
        .json().await.unwrap();
    let payload = parse_text(v);
    assert_eq!(payload["total"], 1);
    assert_eq!(payload["characters"][0]["name"], "River Cartwright");

    // chat_with_character resolves by alias and returns the bridged reply.
    let v: serde_json::Value = client
        .post(&url)
        .json(&call("chat_with_character", json!({ "character": "river", "message": "hello" })))
        .send().await.unwrap()
        .json().await.unwrap();
    let payload = parse_text(v);
    assert_eq!(payload["character"], "River Cartwright");
    assert_eq!(payload["reply"], "echo:char-1:hello");

    // Unknown character surfaces as an MCP tool error, not a transport one.
    let v: serde_json::Value = client
        .post(&url)
        .json(&call("chat_with_character", json!({ "character": "nobody", "message": "hi" })))
        .send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(v["result"]["isError"], true);

    // GET (SSE stream) is not offered by this stateless server.
    let res = client.get(&url).send().await.unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);

    let _ = std::fs::remove_file(&path);
}
