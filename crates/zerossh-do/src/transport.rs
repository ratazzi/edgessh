use std::pin::Pin;
use std::task::{Context, Poll};

use send_wrapper::SendWrapper;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

/// Transport backed by JS callbacks instead of a WebSocket.
///
/// - Reads come from an `mpsc` channel fed by `push_data()` on the JS side.
/// - Writes invoke a JS callback that forwards bytes to a TCP socket.
pub struct JsCallbackTransport {
    rx: SendWrapper<mpsc::UnboundedReceiver<Vec<u8>>>,
    write_fn: SendWrapper<js_sys::Function>,
    pending: Vec<u8>,
    offset: usize,
}

impl JsCallbackTransport {
    pub fn new(
        rx: mpsc::UnboundedReceiver<Vec<u8>>,
        write_fn: js_sys::Function,
    ) -> Self {
        Self {
            rx: SendWrapper::new(rx),
            write_fn: SendWrapper::new(write_fn),
            pending: Vec::new(),
            offset: 0,
        }
    }
}

impl AsyncRead for JsCallbackTransport {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();

        // Serve from pending buffer first
        if this.offset < this.pending.len() {
            let remaining = &this.pending[this.offset..];
            let n = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..n]);
            this.offset += n;
            if this.offset >= this.pending.len() {
                this.pending.clear();
                this.offset = 0;
            }
            return Poll::Ready(Ok(()));
        }

        // Try to receive new data from the channel
        match this.rx.poll_recv(cx) {
            Poll::Ready(Some(data)) => {
                let n = data.len().min(buf.remaining());
                buf.put_slice(&data[..n]);
                if n < data.len() {
                    this.pending = data;
                    this.offset = n;
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(None) => {
                // Channel closed — EOF
                Poll::Ready(Ok(()))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl AsyncWrite for JsCallbackTransport {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let arr = js_sys::Uint8Array::from(buf);
        this.write_fn
            .call1(&JsValue::NULL, &arr)
            .map_err(|e| std::io::Error::other(format!("{e:?}")))?;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
