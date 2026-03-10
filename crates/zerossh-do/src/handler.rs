use std::cell::RefCell;

use russh::client::{Handler, Session};
use russh::keys::PublicKeyBase64;
use russh::ChannelId;
use ssh_key::PublicKey;
use wasm_bindgen::prelude::*;

thread_local! {
    static EXPECTED_HOST_KEY: RefCell<Option<String>> = const { RefCell::new(None) };
    static ACCEPTED_HOST_KEY: RefCell<Option<String>> = const { RefCell::new(None) };
}

pub fn set_expected(key: Option<String>) {
    EXPECTED_HOST_KEY.with(|h| *h.borrow_mut() = key);
}

pub fn take_accepted() -> Option<String> {
    ACCEPTED_HOST_KEY.with(|h| h.borrow_mut().take())
}

fn serialize_key(key: &PublicKey) -> String {
    format!("{} {}", key.algorithm().as_str(), key.public_key_base64())
}

pub struct SshHandler {
    data_cb: js_sys::Function,
}

impl SshHandler {
    pub fn new(data_cb: js_sys::Function) -> Self {
        Self { data_cb }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("{0}")]
    Russh(#[from] russh::Error),
    #[error("{0}")]
    Js(String),
}

#[allow(clippy::manual_async_fn)]
impl Handler for SshHandler {
    type Error = SshError;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> {
        let actual = serialize_key(server_public_key);
        let expected = EXPECTED_HOST_KEY.with(|h| h.borrow().clone());

        let result = match expected.as_deref() {
            None | Some("") => {
                // First connection — accept and record
                ACCEPTED_HOST_KEY.with(|h| *h.borrow_mut() = Some(actual));
                Ok(true)
            }
            Some(exp) if exp == actual => {
                // Key matches — accept
                ACCEPTED_HOST_KEY.with(|h| *h.borrow_mut() = Some(actual));
                Ok(true)
            }
            _ => {
                // Key mismatch — reject (possible MITM)
                Err(SshError::Js("host_key_mismatch".to_string()))
            }
        };

        async { result }
    }

    fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> {
        let data = data.to_vec();
        let cb = self.data_cb.clone();
        async move {
            let arr = js_sys::Uint8Array::from(data.as_slice());
            cb.call1(&JsValue::NULL, &arr)
                .map_err(|e| SshError::Js(format!("{e:?}")))?;
            Ok(())
        }
    }
}
