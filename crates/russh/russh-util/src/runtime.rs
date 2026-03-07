use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

#[derive(Debug)]
pub struct JoinError;

impl std::fmt::Display for JoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JoinError")
    }
}

impl std::error::Error for JoinError {}

#[cfg(not(target_arch = "wasm32"))]
pub struct JoinHandle<T>
where
    T: Send,
{
    handle: tokio::sync::oneshot::Receiver<T>,
}

#[cfg(target_arch = "wasm32")]
pub struct JoinHandle<T> {
    handle: tokio::sync::oneshot::Receiver<T>,
}

#[cfg(not(target_arch = "wasm32"))]
pub fn spawn<F, T>(future: F) -> JoinHandle<T>
where
    F: Future<Output = T> + 'static + Send,
    T: Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async {
        let result = future.await;
        let _ = sender.send(result);
    });
    JoinHandle { handle: receiver }
}

#[cfg(target_arch = "wasm32")]
pub fn spawn<F, T>(future: F) -> JoinHandle<T>
where
    F: Future<Output = T> + 'static,
    T: 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    wasm_bindgen_futures::spawn_local(async {
        let result = future.await;
        let _ = sender.send(result);
    });
    JoinHandle { handle: receiver }
}

#[cfg(not(target_arch = "wasm32"))]
impl<T> Future for JoinHandle<T>
where
    T: Send,
{
    type Output = Result<T, JoinError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.handle).poll(cx) {
            Poll::Ready(Ok(val)) => Poll::Ready(Ok(val)),
            Poll::Ready(Err(_)) => Poll::Ready(Err(JoinError)),
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl<T> Future for JoinHandle<T> {
    type Output = Result<T, JoinError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.handle).poll(cx) {
            Poll::Ready(Ok(val)) => Poll::Ready(Ok(val)),
            Poll::Ready(Err(_)) => Poll::Ready(Err(JoinError)),
            Poll::Pending => Poll::Pending,
        }
    }
}
