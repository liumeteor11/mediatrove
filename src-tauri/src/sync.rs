use axum::{routing::get, Router, Json, extract::State, http::{HeaderMap, StatusCode}};
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::collections::HashMap;
use crate::database::Database;
use mdns_sd::{ServiceDaemon, ServiceInfo, ServiceEvent};
use local_ip_address::local_ip;
use serde::{Deserialize, Serialize};

use std::sync::atomic::{AtomicBool, Ordering};

/// Fires after a peer pushed data into this instance, so the frontend can
/// refresh its stores. Same decoupled-callback pattern as `mcp::NotifyFn`:
/// mentioning the Tauri AppHandle here would drag the GUI stack into the test
/// binary.
pub type SyncNotifyFn = dyn Fn(&str, &str) + Send + Sync;

#[derive(Clone)]
pub struct SyncState {
    pub db: Arc<Database>,
    pub notify: Option<Arc<SyncNotifyFn>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PeerInfo {
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub last_seen: u64,
}

#[derive(Clone)]
pub struct SyncService {
    mdns: ServiceDaemon,
    port: u16,
    peers: Arc<RwLock<HashMap<String, PeerInfo>>>,
    running: Arc<AtomicBool>,
    /// Our own mDNS instance fullname (`MediaTrove_{hostname}`) so discovery
    /// can skip advertising ourselves back to us.
    own_instance: Arc<RwLock<Option<String>>>,
}

impl SyncService {
    pub fn new() -> Self {
        let mdns = ServiceDaemon::new().expect("Failed to create mdns daemon");
        Self {
            mdns,
            port: 14567,
            peers: Arc::new(RwLock::new(HashMap::new())),
            running: Arc::new(AtomicBool::new(false)),
            own_instance: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn start_server(&self, db: Arc<Database>, notify: Option<Arc<SyncNotifyFn>>) {
        if self.running.load(Ordering::SeqCst) {
            println!("Sync server already running");
            return;
        }

        let state = SyncState { db, notify };

        let app = Router::new()
            .route("/sync/data", get(get_data).post(receive_data))
            .with_state(state);

        // Bind on all interfaces: local_ip() can land on a virtual adapter
        // (VPN/proxy TUN), which LAN peers would never reach.
        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));

        println!("Starting Sync Server on {}", addr);

        // Run server first; only announce via mDNS once the port is bound so a
        // failed bind never leaves a stale advertisement behind.
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                self.running.store(true, Ordering::SeqCst);

                let hostname = get_hostname();
                let service_type = "_mediatrove._tcp.local.";
                let instance_name = format!("MediaTrove_{}", hostname);

                if let Some(ip) = select_advertise_ip(local_ip().ok()) {
                    let service_info = ServiceInfo::new(
                        service_type,
                        &instance_name,
                        &format!("{}.local.", hostname),
                        &ip.to_string(),
                        self.port,
                        [("version", "1")].as_slice()
                    ).expect("Valid service info");

                    if let Err(e) = self.mdns.register(service_info) {
                        eprintln!("Failed to register mDNS: {}", e);
                    }
                } else {
                    eprintln!("No routable IPv4 address found; skipping mDNS advertisement");
                }
                if let Ok(mut own) = self.own_instance.write() {
                    *own = Some(instance_name.clone());
                }

                // Start Discovery in background
                self.start_discovery();

                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("Server error: {}", e);
                }
                if let Ok(mut own) = self.own_instance.write() {
                    *own = None;
                }
                self.running.store(false, Ordering::SeqCst);
            },
            Err(e) => eprintln!("Failed to bind sync port: {}", e),
        }
    }

    fn start_discovery(&self) {
        let mdns = self.mdns.clone();
        let peers = self.peers.clone();
        let own_instance = self.own_instance.clone();
        let service_type = "_mediatrove._tcp.local.";

        std::thread::spawn(move || {
            let receiver = mdns.browse(service_type).expect("Failed to browse");
            while let Ok(event) = receiver.recv() {
                match event {
                    ServiceEvent::ServiceResolved(info) => {
                         let fullname = info.get_fullname().to_string();
                         // Skip ourselves. The announced fullname is
                         // `{instance}.{service_type}`, so match on that prefix.
                         let is_own = own_instance
                             .read()
                             .ok()
                             .and_then(|own| own.as_deref().map(|own| fullname.starts_with(&format!("{own}."))))
                             .unwrap_or(false);
                         if is_own {
                             continue;
                         }
                         // Sync targets IPv4 LAN peers only: an IPv6 (or
                         // loopback) address cannot be spliced into the
                         // http://ip:port URL the client will call.
                         let addr = info
                             .get_addresses()
                             .iter()
                             .find(|ip| ip.is_ipv4() && !ip.is_loopback())
                             .map(|ip| ip.to_string());
                         let Some(ip) = addr else { continue; };
                         let port = info.get_port();
                         let hostname = info.get_hostname().to_string();

                         let p = PeerInfo {
                             name: hostname,
                             ip,
                             port,
                             last_seen: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
                         };
                         if let Ok(mut guard) = peers.write() {
                             guard.insert(fullname, p);
                         }
                    },
                    ServiceEvent::ServiceRemoved(_type, fullname) => {
                        if let Ok(mut guard) = peers.write() {
                            guard.remove(&fullname);
                        }
                    }
                    _ => {}
                }
            }
        });
    }

    pub fn get_known_peers(&self) -> Vec<PeerInfo> {
        if let Ok(guard) = self.peers.read() {
            guard.values().cloned().collect()
        } else {
            Vec::new()
        }
    }
}

/// Pick the IPv4 address to advertise over mDNS. `local_ip()` follows the
/// default route and can land on a virtual adapter (VPN/proxy TUN ranges like
/// 198.18.0.0/15), which LAN peers cannot reach — so it is only used when it
/// passes the routability filter; otherwise the first acceptable interface
/// address wins.
pub(crate) fn select_advertise_ip(local_ip: Option<std::net::IpAddr>) -> Option<std::net::IpAddr> {
    let candidates = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, ip)| ip)
        .collect();
    select_advertise_ip_from(local_ip, candidates)
}

/// Pure selection logic over a candidate list; split out for unit tests.
pub(crate) fn select_advertise_ip_from(
    local_ip: Option<std::net::IpAddr>,
    candidates: Vec<std::net::IpAddr>,
) -> Option<std::net::IpAddr> {
    let is_routable_lan = |ip: std::net::IpAddr| -> bool {
        match ip {
            std::net::IpAddr::V4(v4) => {
                let o = v4.octets();
                !v4.is_loopback()
                    && !v4.is_link_local()
                    && !(o[0] == 198 && o[1] >= 18 && o[1] <= 19) // 198.18.0.0/15 benchmark
            }
            std::net::IpAddr::V6(_) => false,
        }
    };

    if let Some(ip) = local_ip {
        if is_routable_lan(ip) {
            return Some(ip);
        }
    }
    candidates.into_iter().find(|ip| is_routable_lan(*ip))
}

fn get_hostname() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "Unknown".to_string())
}

fn check_auth(headers: &HeaderMap, state: &SyncState) -> Result<(), StatusCode> {
    let expected = state.db.get_sync_token();
    if expected.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    match headers.get(axum::http::header::AUTHORIZATION) {
        Some(v) if v.to_str().map(|s| s == format!("Bearer {}", expected)).unwrap_or(false) => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

async fn get_data(headers: HeaderMap, State(state): State<SyncState>, axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>) -> Result<Json<serde_json::Value>, StatusCode> {
    check_auth(&headers, &state)?;
    let username = params.get("user").cloned().unwrap_or_default();
    if username.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let items = state.db.get_user_items(&username).unwrap_or_default();

    // Opt-in full profile: characters, chats and app config (AI keys) are
    // sensitive, so they travel as one AES-256-GCM blob keyed from the
    // pairing code instead of plaintext JSON. Absent for old clients that
    // never ask for it.
    let mut body = serde_json::json!({ "items": items });
    if params.get("include").map(|v| v == "config").unwrap_or(false) {
        let token = state.db.get_sync_token();
        let characters = state.db.get_characters_for_user(&username).unwrap_or_default();
        let chat_sessions = state.db.get_chat_sessions_for_user(&username).unwrap_or_default();
        let (ai_config, theme_config) = state.db.get_configs().unwrap_or((None, None));
        let profile = serde_json::json!({
            "characters": characters,
            "chatSessions": chat_sessions,
            "aiConfig": ai_config,
            "themeConfig": theme_config,
        });
        match crate::crypto::encrypt_profile(&crate::crypto::derive_key(&token), &profile) {
            Ok(encoded) => body["profile"] = serde_json::Value::String(encoded),
            Err(e) => {
                eprintln!("Failed to encrypt sync profile: {e}");
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
        }
    }
    Ok(Json(body))
}

async fn receive_data(headers: HeaderMap, State(state): State<SyncState>, Json(payload): Json<serde_json::Value>) -> Result<Json<serde_json::Value>, StatusCode> {
    check_auth(&headers, &state)?;
    let username = payload.get("user").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if username.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let items: Vec<crate::models::MediaItem> = serde_json::from_value(
        payload.get("items").cloned().unwrap_or(serde_json::Value::Null)
    ).map_err(|_| StatusCode::BAD_REQUEST)?;
    state.db.merge_user_items(&username, items).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(notify) = &state.notify {
        notify(&username, "sync");
    }
    Ok(Json(serde_json::json!({"ok": true})))
}
