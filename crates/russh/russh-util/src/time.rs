use std::future::Future;

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant;

#[cfg(target_arch = "wasm32")]
pub use wasm::Instant;

/// Sleep for a duration. On native, delegates to `tokio::time::sleep`.
/// On wasm32, uses `setTimeout` via JS interop.
#[cfg(not(target_arch = "wasm32"))]
pub fn sleep(duration: std::time::Duration) -> impl Future<Output = ()> {
    tokio::time::sleep(duration)
}

#[cfg(target_arch = "wasm32")]
pub fn sleep(duration: std::time::Duration) -> impl Future<Output = ()> {
    wasm::sleep_ms(duration.as_millis() as i32)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_name = "setTimeout")]
        fn set_timeout(handler: &js_sys::Function, timeout: i32) -> i32;
    }

    pub async fn sleep_ms(ms: i32) {
        let promise = js_sys::Promise::new(&mut |resolve, _| {
            set_timeout(&resolve, ms);
        });
        let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
    }

    #[derive(Debug, Clone, Copy)]
    pub struct Instant {
        inner: chrono::DateTime<chrono::Utc>,
    }

    impl Instant {
        pub fn now() -> Self {
            Instant {
                inner: chrono::Utc::now(),
            }
        }

        pub fn duration_since(&self, earlier: Instant) -> std::time::Duration {
            (self.inner - earlier.inner)
                .to_std()
                .expect("Duration is negative")
        }
    }
}
