//! LAN-sync profile encryption.
//!
//! The sync protocol runs over plaintext HTTP on the LAN. Collection items
//! are not sensitive, but the config profile contains the AI API keys (which
//! are only stored as ciphertext under a *public* static key), so the profile
//! is additionally encrypted with a key derived from the pairing code. A
//! passive sniffer without the pairing code learns nothing usable.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use serde_json::Value;
use sha2::{Digest, Sha256};

const NONCE_LEN: usize = 12;

/// AES-256 key derived from the pairing code both peers already share.
pub(crate) fn derive_key(sync_token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"mediatrove-sync-profile-v1");
    hasher.update(sync_token.as_bytes());
    hasher.finalize().into()
}

/// Encrypt a JSON value into `hex(nonce || ciphertext)`.
pub(crate) fn encrypt_profile(key: &[u8; 32], value: &Value) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut nonce_bytes);
    let plaintext = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let payload = Payload {
        msg: &plaintext,
        aad: b"mediatrove-profile-v1",
    };
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), payload)
        .map_err(|e| format!("profile encrypt failed: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(hex::encode(out))
}

/// Decrypt a `hex(nonce || ciphertext)` profile payload back into JSON.
/// Fails (without partial output) on any tampering or wrong key.
pub(crate) fn decrypt_profile(key: &[u8; 32], encoded: &str) -> Result<Value, String> {
    let raw = hex::decode(encoded.trim()).map_err(|_| "profile payload is not valid hex")?;
    if raw.len() <= NONCE_LEN {
        return Err("profile payload too short".to_string());
    }
    let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let payload = Payload {
        msg: ciphertext,
        aad: b"mediatrove-profile-v1",
    };
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), payload)
        .map_err(|_| "profile decrypt failed: wrong pairing code or corrupted payload")?;
    serde_json::from_slice(&plaintext).map_err(|e| format!("profile payload invalid JSON: {e}"))
}
