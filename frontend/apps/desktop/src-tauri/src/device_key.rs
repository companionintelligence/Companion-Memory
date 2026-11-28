//! The desktop window's device key stays in Rust.
//!
//! The web app signs in once and keeps a durable, full-capability API key in the OS keychain
//! (`memory:ci.apiKey`, through tauri-plugin-ci-auth). Before this module, the page read that key
//! back on every launch and sent it with every request, so any script that ever ran in the page
//! could carry off a key that worked until someone revoked it. Now:
//!
//! - [`device_secure_get_command`] is the page's only way to read the keychain, and it never
//!   returns the device key itself. The plugin's own `secure_get` is no longer granted to the
//!   remote origin (capabilities/remote-device-key.json). The page still writes the key once,
//!   right after it mints it at sign-in, and removes it at sign-out.
//! - [`device_access_token_command`] trades the key, here in Rust, for a short-lived access token
//!   from Memory (`POST /api/keys/access-token`), and the page sends only that.
//!
//! The token is asked for at the fixed gateway address ([`stack_manager::GATEWAY_PORT`] on
//! loopback), never at an address the page names, and redirects are not followed, so the key is
//! only ever sent to the Memory this app runs.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_ci_auth::{AuthError, AuthState};
use tokio::sync::Mutex;

use crate::stack_manager;

/// Where the web app keeps the device key (`memory:` is its namespace in @ci/common's nativeBridge.ts).
pub const DEVICE_KEY_ENTRY: &str = "memory:ci.apiKey";
/// The key's server-side id, which the page may read.
pub const DEVICE_KEY_ID_ENTRY: &str = "memory:ci.apiKeyId";

/// How long a request for a token may take. Memory answers it with one key lookup.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A cached token is handed out only while it has at least this long left.
const REUSE_MARGIN_MS: i64 = 60_000;
/// Longest lifetime honoured from Memory's answer, whatever it says.
const MAX_LIFETIME_SECONDS: u64 = 3_600;
const MAX_TOKEN_LENGTH: usize = 4_096;
const MAX_RESPONSE_BYTES: usize = 16 * 1024;

/// What [`device_access_token_command`] found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenStatus {
    /// No device key in the keychain: signed out.
    None,
    /// A token, with when it stops working.
    Ok,
    /// Memory refused the key (401 or 403). The key is left where it is; signing out is the page's call.
    Revoked,
    /// Memory did not answer usefully, or the keychain could not be read. Still signed in; ask again later.
    Unreachable,
    /// Memory predates access tokens (404). No token, and never the key itself: the page would hold a
    /// credential that works anywhere until revoked. The page asks the person to update Memory.
    Legacy,
}

/// The answer to `device_access_token_command`, as the page reads it (camelCase).
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAccessToken {
    pub status: TokenStatus,
    pub token: Option<String>,
    /// When `token` stops working, in ms since the epoch. Only for `Ok`.
    pub expires_at: Option<i64>,
    /// The device key's server-side id, when the keychain has one.
    pub key_id: Option<String>,
    /// `outboxOwnerStamp()` for this key, so the page can stamp and match queued captures without the key.
    pub owner_stamp: Option<String>,
}

impl std::fmt::Debug for DeviceAccessToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceAccessToken")
            .field("status", &self.status)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl DeviceAccessToken {
    fn without_token(
        status: TokenStatus,
        key_id: Option<String>,
        owner_stamp: Option<String>,
    ) -> Self {
        Self {
            status,
            token: None,
            expires_at: None,
            key_id,
            owner_stamp,
        }
    }
}

/// The answer to `device_secure_get_command`, shaped like the plugin's `secure_get`.
#[derive(Serialize)]
pub struct SecureValue {
    pub value: Option<String>,
}

/// Whether the page may read the keychain entry `key`. Everything but the device key.
///
/// Compared without regard to case or surrounding space: Windows Credential Manager matches
/// target names case-insensitively, so `memory:CI.APIKEY` would read the same entry there.
pub fn page_may_read(key: &str) -> bool {
    !key.trim().eq_ignore_ascii_case(DEVICE_KEY_ENTRY)
}

/// `secure_get` for the page, refusing the device key (it reads as absent).
pub fn page_secure_get(auth: &AuthState, key: &str) -> Result<SecureValue, AuthError> {
    if !page_may_read(key) {
        log::warn!("[device-key] the page asked to read the device key; refused");
        return Ok(SecureValue { value: None });
    }

    auth.secure_get(key).map(|value| SecureValue { value })
}

/// What one request for a token came back with.
enum MintOutcome {
    Minted { token: String, expires_in: u64 },
    Revoked,
    Legacy,
    Unreachable,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MintBody {
    token: String,
    expires_in: u64,
}

struct CachedToken {
    key_hash: [u8; 32],
    token: String,
    expires_at: i64,
}

/// The app's token state: one HTTP client and the token last handed out. Managed by Tauri.
pub struct DeviceTokens {
    client: reqwest::Client,
    url: String,
    /// Held across a request, so calls that arrive together share one answer.
    cache: Mutex<Option<CachedToken>>,
}

impl DeviceTokens {
    /// Tokens from this app's own Memory, at the fixed gateway port.
    pub fn for_gateway() -> Self {
        Self::with_url(format!(
            "http://127.0.0.1:{}/api/keys/access-token",
            stack_manager::GATEWAY_PORT
        ))
    }

    fn with_url(url: String) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            client,
            url,
            cache: Mutex::new(None),
        }
    }

    /// A token for the device key in `auth`'s keychain, from the cache when one has time left
    /// and `refresh` is false.
    pub async fn resolve(
        &self,
        auth: Arc<AuthState>,
        refresh: bool,
        now_ms: i64,
    ) -> DeviceAccessToken {
        let stored = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, AuthError>((
                auth.secure_get(DEVICE_KEY_ENTRY)?,
                auth.secure_get(DEVICE_KEY_ID_ENTRY)?,
            ))
        })
        .await;

        let (key, key_id) = match stored {
            Ok(Ok(found)) => found,
            // A keychain that cannot be read now says nothing about whether there is a key.
            _ => return DeviceAccessToken::without_token(TokenStatus::Unreachable, None, None),
        };

        let Some(key) = key.filter(|key| !key.is_empty()) else {
            return DeviceAccessToken::without_token(TokenStatus::None, None, None);
        };
        let key_id = key_id.filter(|id| !id.is_empty());
        let owner_stamp = Some(owner_stamp(DESKTOP_ORIGIN, &key));
        let key_hash: [u8; 32] = Sha256::digest(key.as_bytes()).into();

        let mut cache = self.cache.lock().await;

        if !refresh {
            if let Some(cached) = cache.as_ref() {
                if cached.key_hash == key_hash && cached.expires_at - REUSE_MARGIN_MS > now_ms {
                    return DeviceAccessToken {
                        status: TokenStatus::Ok,
                        token: Some(cached.token.clone()),
                        expires_at: Some(cached.expires_at),
                        key_id,
                        owner_stamp,
                    };
                }
            }
        }

        match self.mint(&key).await {
            MintOutcome::Minted { token, expires_in } => {
                let lifetime_ms = (expires_in.min(MAX_LIFETIME_SECONDS) * 1000) as i64;
                let expires_at = now_ms + lifetime_ms;
                *cache = Some(CachedToken {
                    key_hash,
                    token: token.clone(),
                    expires_at,
                });

                DeviceAccessToken {
                    status: TokenStatus::Ok,
                    token: Some(token),
                    expires_at: Some(expires_at),
                    key_id,
                    owner_stamp,
                }
            }
            MintOutcome::Revoked => {
                *cache = None;
                DeviceAccessToken::without_token(TokenStatus::Revoked, key_id, owner_stamp)
            }
            MintOutcome::Legacy => {
                *cache = None;
                DeviceAccessToken::without_token(TokenStatus::Legacy, key_id, owner_stamp)
            }
            MintOutcome::Unreachable => {
                DeviceAccessToken::without_token(TokenStatus::Unreachable, key_id, owner_stamp)
            }
        }
    }

    async fn mint(&self, key: &str) -> MintOutcome {
        let response = match self
            .client
            .post(&self.url)
            .header("x-api-key", key)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_LENGTH, "0")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                // reqwest's error names the URL, never a header, so the key is not in it.
                log::info!("[device-key] access token request failed: {error}");
                return MintOutcome::Unreachable;
            }
        };

        match response.status().as_u16() {
            200 => {}
            401 | 403 => return MintOutcome::Revoked,
            404 => return MintOutcome::Legacy,
            status => {
                log::info!("[device-key] access token request answered {status}");
                return MintOutcome::Unreachable;
            }
        }

        let Ok(body) = response.bytes().await else {
            return MintOutcome::Unreachable;
        };

        if body.len() > MAX_RESPONSE_BYTES {
            return MintOutcome::Unreachable;
        }

        match serde_json::from_slice::<MintBody>(&body) {
            Ok(MintBody { token, expires_in })
                if expires_in > 0
                    && !token.is_empty()
                    && token.len() <= MAX_TOKEN_LENGTH
                    && token.bytes().all(|byte| byte.is_ascii_graphic()) =>
            {
                MintOutcome::Minted { token, expires_in }
            }
            _ => MintOutcome::Unreachable,
        }
    }
}

/// The API origin the desktop page has: `''`. `initApiBaseUrl` (@ci/common apiBase.ts) returns at once
/// when `isNativePlatform()` is false, which it always is under Tauri, and no build sets
/// `VITE_API_BASE_URL`, so `getApiBaseUrl()` is the empty build default and the page calls Memory
/// same-origin.
const DESKTOP_ORIGIN: &str = "";

/// `outboxOwnerStamp()` from @ci/common's outbox.ts, ported like the Android and iOS uploaders' copies:
/// the origin plus a fingerprint of origin and key. Rows already queued carry this value, so it must
/// match the web function bit for bit.
pub fn owner_stamp(origin: &str, api_key: &str) -> String {
    let label = if origin.is_empty() {
        "same-origin"
    } else {
        origin
    };
    format!("{label} {}", fingerprint(&format!("{origin}\n{api_key}")))
}

/// cyrb53 over UTF-16 code units, as JavaScript's `charCodeAt` sees the string. `wrapping_mul` on
/// u32 is `Math.imul`'s low 32 bits; `>>` on u32 is `>>>`.
fn fingerprint(value: &str) -> String {
    let mut h1: u32 = 0xdeadbeef;
    let mut h2: u32 = 0x41c6ce57;

    for unit in value.encode_utf16() {
        let code = u32::from(unit);
        h1 = (h1 ^ code).wrapping_mul(2_654_435_761);
        h2 = (h2 ^ code).wrapping_mul(1_597_334_677);
    }

    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2_246_822_507);
    h1 ^= (h2 ^ (h2 >> 13)).wrapping_mul(3_266_489_909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2_246_822_507);
    h2 ^= (h1 ^ (h1 >> 13)).wrapping_mul(3_266_489_909);

    let combined = (u64::from(h2 & 0x1f_ffff) << 32) + u64::from(h1);
    format!("{combined:014x}")
}

/// Milliseconds since the epoch, for token lifetimes.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_ci_auth::MemoryBackend;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn auth_with(entries: &[(&str, &str)]) -> Arc<AuthState> {
        let state = AuthState::new(Arc::new(MemoryBackend::default()));
        for (key, value) in entries {
            state.secure_set(key, value).expect("set");
        }
        Arc::new(state)
    }

    /// A one-route HTTP server answering every request with `status` and `body`, and the requests it saw.
    async fn server(
        status: u16,
        body: &'static str,
    ) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!(
            "http://{}/api/keys/access-token",
            listener.local_addr().expect("addr")
        );
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);

        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let read = socket.read(&mut buf).await.unwrap_or(0);
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..read]).into_owned());
                let reason = match status {
                    200 => "OK",
                    302 => "Found",
                    _ => "Status",
                };
                let extra = if status == 302 {
                    "Location: http://127.0.0.1:1/elsewhere\r\n"
                } else {
                    ""
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });

        (url, seen)
    }

    #[test]
    fn matches_the_stamps_the_web_side_computes() {
        // The fixtures OutboxOwnerStampTest.kt pins, computed by outbox.ts.
        assert_eq!(
            owner_stamp("https://memory.example.lan", "ci_live_abc123"),
            "https://memory.example.lan 18c1c4e1a552fb"
        );
        assert_eq!(
            owner_stamp("http://192.168.86.20:8080", "k"),
            "http://192.168.86.20:8080 156750bf98f9fd"
        );
        assert_eq!(
            owner_stamp("https://hub.ci.computer/m/é", "ключ-🔑"),
            "https://hub.ci.computer/m/é 0eda9c072179f5"
        );
    }

    #[test]
    fn labels_the_desktop_same_origin_stamp_as_the_web_does() {
        assert!(owner_stamp(DESKTOP_ORIGIN, KEY).starts_with("same-origin "));
        assert_eq!(
            owner_stamp(DESKTOP_ORIGIN, KEY).len(),
            "same-origin ".len() + 14
        );
    }

    #[test]
    fn never_lets_the_page_read_the_device_key() {
        let auth = auth_with(&[
            (DEVICE_KEY_ENTRY, KEY),
            (DEVICE_KEY_ID_ENTRY, "key-1"),
            ("memory:ci.apiKeyCapability", "full"),
        ]);

        for spelling in [DEVICE_KEY_ENTRY, "memory:CI.APIKEY", " memory:ci.apiKey "] {
            assert_eq!(
                page_secure_get(&auth, spelling).expect("get").value,
                None,
                "{spelling}"
            );
        }
        assert_eq!(
            page_secure_get(&auth, DEVICE_KEY_ID_ENTRY)
                .expect("get")
                .value
                .as_deref(),
            Some("key-1")
        );
        assert_eq!(
            page_secure_get(&auth, "memory:ci.apiKeyCapability")
                .expect("get")
                .value
                .as_deref(),
            Some("full")
        );
        assert_eq!(
            page_secure_get(&auth, "").err(),
            Some(AuthError::BadRequest)
        );
    }

    #[tokio::test]
    async fn is_none_without_a_key_and_asks_nothing() {
        let (url, seen) = server(200, r#"{"token":"t","expiresIn":300}"#).await;
        let tokens = DeviceTokens::with_url(url);

        let result = tokens.resolve(auth_with(&[]), false, 1_000).await;

        assert_eq!(
            result,
            DeviceAccessToken::without_token(TokenStatus::None, None, None)
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn trades_the_key_for_a_token_and_reuses_it_until_a_minute_is_left() {
        let (url, seen) = server(
            200,
            r#"{"token":"aaa.bbb.ccc","expiresAt":"x","expiresIn":300}"#,
        )
        .await;
        let tokens = DeviceTokens::with_url(url);
        let auth = auth_with(&[(DEVICE_KEY_ENTRY, KEY), (DEVICE_KEY_ID_ENTRY, "key-1")]);

        let first = tokens.resolve(Arc::clone(&auth), false, 1_000_000).await;
        assert_eq!(first.status, TokenStatus::Ok);
        assert_eq!(first.token.as_deref(), Some("aaa.bbb.ccc"));
        assert_eq!(first.expires_at, Some(1_000_000 + 300_000));
        assert_eq!(first.key_id.as_deref(), Some("key-1"));
        assert_eq!(first.owner_stamp, Some(owner_stamp("", KEY)));

        {
            let requests = seen.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].starts_with("POST /api/keys/access-token "));
            assert!(requests[0]
                .to_ascii_lowercase()
                .contains(&format!("x-api-key: {KEY}")));
        }

        // Within the window: from the cache.
        let again = tokens
            .resolve(Arc::clone(&auth), false, 1_000_000 + 239_000)
            .await;
        assert_eq!(again, first);
        assert_eq!(seen.lock().unwrap().len(), 1);

        // Under a minute left, or asked to refresh: a new request.
        tokens
            .resolve(Arc::clone(&auth), false, 1_000_000 + 241_000)
            .await;
        tokens
            .resolve(Arc::clone(&auth), true, 1_000_000 + 241_001)
            .await;
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn does_not_hand_out_a_token_cached_for_another_key() {
        let (url, seen) = server(200, r#"{"token":"aaa.bbb.ccc","expiresIn":300}"#).await;
        let tokens = DeviceTokens::with_url(url);

        tokens
            .resolve(auth_with(&[(DEVICE_KEY_ENTRY, KEY)]), false, 0)
            .await;
        tokens
            .resolve(auth_with(&[(DEVICE_KEY_ENTRY, "other")]), false, 1)
            .await;

        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn caps_a_lifetime_memory_overstates() {
        let (url, _) = server(200, r#"{"token":"aaa.bbb.ccc","expiresIn":999999}"#).await;
        let result = DeviceTokens::with_url(url)
            .resolve(auth_with(&[(DEVICE_KEY_ENTRY, KEY)]), false, 0)
            .await;

        assert_eq!(result.expires_at, Some(3_600_000));
    }

    #[tokio::test]
    async fn maps_each_answer_to_a_status() {
        let auth = || auth_with(&[(DEVICE_KEY_ENTRY, KEY), (DEVICE_KEY_ID_ENTRY, "key-1")]);

        for (status, body, expected) in [
            (401, "{}", TokenStatus::Revoked),
            (403, "{}", TokenStatus::Revoked),
            (500, "{}", TokenStatus::Unreachable),
            (302, "", TokenStatus::Unreachable),
            (200, "not json", TokenStatus::Unreachable),
            (
                200,
                r#"{"token":"","expiresIn":300}"#,
                TokenStatus::Unreachable,
            ),
            (
                200,
                r#"{"token":"has space","expiresIn":300}"#,
                TokenStatus::Unreachable,
            ),
            (
                200,
                r#"{"token":"aaa.bbb.ccc","expiresIn":0}"#,
                TokenStatus::Unreachable,
            ),
        ] {
            let (url, _) = server(status, body).await;
            let result = DeviceTokens::with_url(url).resolve(auth(), false, 0).await;
            assert_eq!(result.status, expected, "{status} {body}");
            assert_eq!(result.token, None, "{status} {body}");
            assert_eq!(result.key_id.as_deref(), Some("key-1"));
        }
    }

    #[tokio::test]
    async fn hands_the_page_no_token_and_never_the_key_for_a_memory_too_old_for_tokens() {
        let (url, _) = server(404, "{}").await;
        let result = DeviceTokens::with_url(url)
            .resolve(auth_with(&[(DEVICE_KEY_ENTRY, KEY)]), false, 0)
            .await;

        assert_eq!(result.status, TokenStatus::Legacy);
        assert_eq!(result.token, None);
        assert_eq!(result.expires_at, None);
    }

    #[tokio::test]
    async fn forgets_the_cached_token_once_memory_refuses_the_key() {
        let (url, seen) = server(200, r#"{"token":"aaa.bbb.ccc","expiresIn":300}"#).await;
        let tokens = DeviceTokens::with_url(url);
        let auth = auth_with(&[(DEVICE_KEY_ENTRY, KEY)]);
        tokens.resolve(Arc::clone(&auth), false, 0).await;

        let (refusing, _) = server(401, "{}").await;
        let tokens = DeviceTokens {
            url: refusing,
            ..tokens
        };
        assert_eq!(
            tokens.resolve(Arc::clone(&auth), true, 1).await.status,
            TokenStatus::Revoked
        );
        assert!(tokens.cache.lock().await.is_none());
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn is_unreachable_when_nothing_listens() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!(
            "http://{}/api/keys/access-token",
            listener.local_addr().expect("addr")
        );
        drop(listener);

        let result = DeviceTokens::with_url(url)
            .resolve(auth_with(&[(DEVICE_KEY_ENTRY, KEY)]), false, 0)
            .await;

        assert_eq!(result.status, TokenStatus::Unreachable);
        assert_eq!(result.owner_stamp, Some(owner_stamp("", KEY)));
    }

    #[test]
    fn asks_only_this_apps_gateway() {
        assert_eq!(
            DeviceTokens::for_gateway().url,
            format!(
                "http://127.0.0.1:{}/api/keys/access-token",
                stack_manager::GATEWAY_PORT
            )
        );
    }

    #[test]
    fn keeps_the_token_out_of_debug_output() {
        let token = DeviceAccessToken {
            status: TokenStatus::Ok,
            token: Some("secret.token.value".into()),
            expires_at: Some(1),
            key_id: None,
            owner_stamp: None,
        };
        assert!(!format!("{token:?}").contains("secret"));
    }
}
