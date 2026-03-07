use std::pin::Pin;
use std::task::{Context, Poll};

use send_wrapper::SendWrapper;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use ws_stream_wasm::WsStream;

/// The IoStream type returned by WsStream::into_io() with tokio_io feature.
/// This implements tokio::io::AsyncRead + AsyncWrite.
type WsIo = async_io_stream::IoStream<ws_stream_wasm::WsStreamIo, Vec<u8>>;

/// Wraps WsStream (converted to IoStream) in SendWrapper to satisfy Send bounds.
/// Safe on wasm32 since there's only one thread.
pub struct WsTransport {
    inner: SendWrapper<WsIo>,
}

impl WsTransport {
    pub fn new(ws: WsStream) -> Self {
        Self {
            inner: SendWrapper::new(ws.into_io()),
        }
    }
}

impl AsyncRead for WsTransport {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for WsTransport {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut *this.inner).poll_shutdown(cx)
    }
}
