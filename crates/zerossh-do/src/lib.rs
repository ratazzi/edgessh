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
use tokio::sync::mpsc;
use transport::JsCallbackTransport;
use wasm_bindgen::prelude::*;

/// Feeds TCP data into the WASM SSH transport.
/// Separate from the builder so it can be used concurrently with `connect()`.
#[wasm_bindgen]
pub struct SshTransportFeeder {
    tx: SendWrapper<mpsc::UnboundedSender<Vec<u8>>>,
}

#[wasm_bindgen]
impl SshTransportFeeder {
    /// Push data received from the TCP socket into the SSH transport.
    #[wasm_bindgen]
    pub fn push_data(&self, data: &[u8]) {
        let _ = self.tx.send(data.to_vec());
    }
}

/// Creates the SSH transport and returns a builder + feeder pair.
/// The feeder can be used immediately to push TCP data, while the builder
/// is used to run the SSH handshake.
#[wasm_bindgen]
pub struct SshSessionBuilder {
    transport: SendWrapper<Option<JsCallbackTransport>>,
    on_data: SendWrapper<js_sys::Function>,
}

#[wasm_bindgen]
impl SshSessionBuilder {
    /// Create a new builder + feeder pair.
    ///
    /// - `on_write`: JS callback `(data: Uint8Array) => void` — WASM writes SSH bytes here
    /// - `on_data`: JS callback `(data: Uint8Array) => void` — terminal output from SSH server
    ///
    /// Returns the builder. Call `create_feeder()` to get the feeder for pushing TCP data.
    #[wasm_bindgen(constructor)]
    pub fn new(on_write: js_sys::Function, on_data: js_sys::Function) -> SshSessionBuilder {
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let transport = JsCallbackTransport::new(rx, on_write);

        // Store tx temporarily so create_feeder() can clone it
        TX_HOLDER.with(|h| {
            *h.borrow_mut() = Some(tx);
        });

        SshSessionBuilder {
            transport: SendWrapper::new(Some(transport)),
            on_data: SendWrapper::new(on_data),
        }
    }

    /// Get the feeder for pushing TCP data. Call this before `connect()`.
    /// The feeder is a separate object that can be used concurrently with connect().
    #[wasm_bindgen]
    pub fn create_feeder(&self) -> Result<SshTransportFeeder, JsValue> {
        TX_HOLDER.with(|h| {
            let tx = h
                .borrow()
                .as_ref()
                .ok_or_else(|| JsValue::from_str("create_feeder() already called or builder not initialized"))?
                .clone();
            Ok(SshTransportFeeder {
                tx: SendWrapper::new(tx),
            })
        })
    }

    /// Run the SSH handshake, authenticate, open a PTY+shell.
    #[wasm_bindgen]
    pub async fn connect(
        &mut self,
        username: &str,
        auth_type: &str,
        credential: &str,
        passphrase: &str,
        cols: u32,
        rows: u32,
    ) -> Result<SshSession, JsValue> {
        // Clean up the tx holder
        TX_HOLDER.with(|h| { h.borrow_mut().take(); });

        let transport = (*self.transport)
            .take()
            .ok_or_else(|| JsValue::from_str("connect() already called"))?;

        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            keepalive_max: 6,
            ..Default::default()
        });

        let handler = SshHandler::new((*self.on_data).clone());

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

        let (mut read_half, write_half) = channel.split();

        // Drain the read half to prevent buffer fill-up
        wasm_bindgen_futures::spawn_local(async move {
            while read_half.wait().await.is_some() {
                // Data is delivered via Handler::data() callback
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

        Ok(SshSession {
            handle: SendWrapper::new(handle),
            channel: SendWrapper::new(write_half),
        })
    }
}

// Thread-local to pass the tx from new() to create_feeder()
// (avoids storing it in the builder struct which would cause borrow issues)
thread_local! {
    static TX_HOLDER: std::cell::RefCell<Option<mpsc::UnboundedSender<Vec<u8>>>> =
        const { std::cell::RefCell::new(None) };
}

/// A connected SSH session with PTY+shell.
#[wasm_bindgen]
pub struct SshSession {
    handle: SendWrapper<Handle<SshHandler>>,
    channel: SendWrapper<ChannelWriteHalf<client::Msg>>,
}

#[wasm_bindgen]
impl SshSession {
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
