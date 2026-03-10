use russh::client::{Handler, Session};
use russh::ChannelId;
use ssh_key::PublicKey;
use wasm_bindgen::prelude::*;

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
        _server_public_key: &PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> {
        async { Ok(true) }
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
