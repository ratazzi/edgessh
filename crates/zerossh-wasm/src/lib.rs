#![allow(clippy::too_many_arguments)]

mod handler;
mod transport;

use std::sync::Arc;

use handler::{SshError, SshHandler};
use russh::client::{self, Handle};
use russh::ChannelWriteHalf;
use russh::keys::decode_secret_key;
use russh::keys::key::PrivateKeyWithHashAlg;
use send_wrapper::SendWrapper;
use transport::WsTransport;
use wasm_bindgen::prelude::*;
use ws_stream_wasm::WsMeta;

#[wasm_bindgen]
pub struct SshClient {
    handle: SendWrapper<Handle<SshHandler>>,
    channel: SendWrapper<ChannelWriteHalf<client::Msg>>,
}

#[wasm_bindgen]
impl SshClient {
    /// Connect to an SSH server via a WebSocket proxy.
    ///
    /// - `ws_url`: WebSocket URL of the proxy (e.g. `wss://proxy.example.com/proxy?host=1.2.3.4&port=22`)
    /// - `username`: SSH username
    /// - `auth_type`: "password" or "key"
    /// - `credential`: password string or PEM private key
    /// - `passphrase`: optional passphrase for encrypted keys (empty string if none)
    /// - `cols`/`rows`: initial terminal size
    /// - `on_data`: JS callback `(data: Uint8Array) => void` for received data
    #[wasm_bindgen]
    pub async fn connect(
        ws_url: &str,
        username: &str,
        auth_type: &str,
        credential: &str,
        passphrase: &str,
        cols: u32,
        rows: u32,
        on_data: js_sys::Function,
    ) -> Result<SshClient, JsValue> {
        // Initialize console logger (idempotent, second call is no-op)
        let _ = console_log::init_with_level(log::Level::Info);

        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            keepalive_max: 6,
            ..Default::default()
        });

        let handler = SshHandler::new(on_data);

        // Connect WebSocket
        let (_, ws_stream) = WsMeta::connect(ws_url, None)
            .await
            .map_err(|e| JsValue::from_str(&format!("WebSocket connect failed: {e}")))?;
        let transport = WsTransport::new(ws_stream);

        // SSH handshake
        let mut handle = client::connect_stream(config, transport, handler)
            .await
            .map_err(|e: SshError| JsValue::from_str(&format!("SSH handshake failed: {e}")))?;

        // Authenticate
        let auth_result = match auth_type {
            "password" => handle
                .authenticate_password(username, credential)
                .await
                .map_err(|e| JsValue::from_str(&format!("Auth failed: {e}")))?,
            "key" => {
                let pass = if passphrase.is_empty() {
                    None
                } else {
                    Some(passphrase)
                };
                let key = decode_secret_key(credential, pass)
                    .map_err(|e| JsValue::from_str(&format!("Invalid key: {e}")))?;
                let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                handle
                    .authenticate_publickey(username, key_with_alg)
                    .await
                    .map_err(|e| JsValue::from_str(&format!("Auth failed: {e}")))?
            }
            _ => return Err(JsValue::from_str("auth_type must be 'password' or 'key'")),
        };

        if !auth_result.success() {
            return Err(JsValue::from_str("Authentication rejected by server"));
        }

        // Open session channel
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| JsValue::from_str(&format!("Channel open failed: {e}")))?;

        // Split channel: we only need the write half for sending data/resize.
        // The read half must be drained to prevent the bounded channel buffer
        // from filling up, which would block the SSH event loop.
        let (mut read_half, write_half) = channel.split();

        // Spawn background task to drain channel read buffer
        wasm_bindgen_futures::spawn_local(async move {
            while read_half.wait().await.is_some() {
                // Discard — data is delivered via Handler::data() callback
            }
        });

        // Request PTY
        write_half
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| JsValue::from_str(&format!("PTY request failed: {e}")))?;

        // Request shell
        write_half
            .request_shell(true)
            .await
            .map_err(|e| JsValue::from_str(&format!("Shell request failed: {e}")))?;

        Ok(SshClient {
            handle: SendWrapper::new(handle),
            channel: SendWrapper::new(write_half),
        })
    }

    /// Send terminal input data to the remote shell.
    #[wasm_bindgen]
    pub async fn send_data(&self, data: &[u8]) -> Result<(), JsValue> {
        self.channel
            .data(data)
            .await
            .map_err(|e| JsValue::from_str(&format!("Send data failed: {e}")))?;
        Ok(())
    }

    /// Notify the server of terminal window size change.
    #[wasm_bindgen]
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), JsValue> {
        self.channel
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| JsValue::from_str(&format!("Resize failed: {e}")))?;
        Ok(())
    }

    /// Check if the SSH connection is still alive.
    #[wasm_bindgen]
    pub fn is_connected(&self) -> bool {
        !self.handle.is_closed()
    }

    /// Disconnect the SSH session.
    #[wasm_bindgen]
    pub async fn disconnect(&self) -> Result<(), JsValue> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "user disconnect", "en")
            .await
            .map_err(|e| JsValue::from_str(&format!("Disconnect failed: {e}")))?;
        Ok(())
    }
}
