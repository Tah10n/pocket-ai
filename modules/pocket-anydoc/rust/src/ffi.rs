//! The only module allowed to dereference foreign pointers or reconstruct
//! owned buffers. Every exported entry point contains Rust and dependency
//! panics before they can cross the C ABI.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::slice;
use std::str;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use serde_json::Value;

use crate::engine::PocketAnyDocEngine;
use crate::error::CoreError;
use crate::limits::{MAX_REQUEST_JSON_BYTES, MAX_RESPONSE_JSON_BYTES};
use crate::schema::{failure, success};

static OUTSTANDING_BUFFERS: AtomicUsize = AtomicUsize::new(0);

/// Owned response bytes transferred across the C ABI. The caller must return
/// each non-empty value exactly once to `pocket_anydoc_buffer_free`.
#[repr(C)]
pub struct PocketAnyDocBuffer {
    pub ptr: *mut u8,
    pub len: usize,
    pub capacity: usize,
}

impl PocketAnyDocBuffer {
    fn empty() -> Self {
        Self {
            ptr: ptr::null_mut(),
            len: 0,
            capacity: 0,
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_engine_new() -> *mut PocketAnyDocEngine {
    catch_unwind(|| Box::into_raw(Box::new(PocketAnyDocEngine::new()))).unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_engine_free(engine: *mut PocketAnyDocEngine) {
    if engine.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: ownership was created by pocket_anydoc_engine_new and the
        // C contract requires engine_free exactly once after in-flight calls.
        unsafe { drop(Box::from_raw(engine)) };
    }));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_version() -> PocketAnyDocBuffer {
    value_entry(PocketAnyDocEngine::version)
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_capabilities() -> PocketAnyDocBuffer {
    value_entry(PocketAnyDocEngine::capabilities)
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_prepare(
    engine: *mut PocketAnyDocEngine,
    request: *const u8,
    request_len: usize,
) -> PocketAnyDocBuffer {
    request_entry(engine, request, request_len, PocketAnyDocEngine::prepare)
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_select_context(
    engine: *mut PocketAnyDocEngine,
    request: *const u8,
    request_len: usize,
) -> PocketAnyDocBuffer {
    request_entry(engine, request, request_len, PocketAnyDocEngine::select)
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_materialize_asset(
    engine: *mut PocketAnyDocEngine,
    request: *const u8,
    request_len: usize,
) -> PocketAnyDocBuffer {
    request_entry(
        engine,
        request,
        request_len,
        PocketAnyDocEngine::materialize,
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_cancel(
    engine: *mut PocketAnyDocEngine,
    request: *const u8,
    request_len: usize,
) -> PocketAnyDocBuffer {
    request_entry(engine, request, request_len, PocketAnyDocEngine::cancel)
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_release(
    engine: *mut PocketAnyDocEngine,
    request: *const u8,
    request_len: usize,
) -> PocketAnyDocBuffer {
    request_entry(engine, request, request_len, PocketAnyDocEngine::release)
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_anydoc_buffer_free(buffer: PocketAnyDocBuffer) {
    if buffer.ptr.is_null() {
        return;
    }
    if buffer.capacity < buffer.len {
        // A modified foreign descriptor cannot safely be reconstructed. This
        // intentionally leaks rather than dereferencing invalid ownership.
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: make_buffer transfers this exact Vec allocation and its
        // original length/capacity. The C contract requires one return only.
        unsafe { drop(Vec::from_raw_parts(buffer.ptr, buffer.len, buffer.capacity)) };
        OUTSTANDING_BUFFERS.fetch_sub(1, Ordering::Relaxed);
    }));
}

fn request_entry(
    engine: *mut PocketAnyDocEngine,
    request: *const u8,
    request_len: usize,
    operation: fn(&PocketAnyDocEngine, &str) -> Result<Value, CoreError>,
) -> PocketAnyDocBuffer {
    ffi_entry(|| {
        if engine.is_null() {
            return Err(CoreError::InvalidRequest("engine"));
        }
        let request = request_string(request, request_len)?;
        // SAFETY: null is rejected above. The native wrappers hold engine
        // lifetime/read gates around all calls and free only after completion.
        let engine = unsafe { &*engine };
        operation(engine, &request)
    })
}

fn request_string(request: *const u8, request_len: usize) -> Result<String, CoreError> {
    if request_len == 0 || request_len > MAX_REQUEST_JSON_BYTES || request.is_null() {
        return Err(if request_len > MAX_REQUEST_JSON_BYTES {
            CoreError::ResourceLimit("max_request_json_bytes")
        } else {
            CoreError::InvalidRequest("request buffer")
        });
    }
    // SAFETY: the caller promises request_len readable bytes for the duration
    // of this synchronous call. The size is bounded before constructing it.
    let bytes = unsafe { slice::from_raw_parts(request, request_len) };
    str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| CoreError::InvalidRequest("utf8"))
}

fn value_entry(operation: fn() -> Value) -> PocketAnyDocBuffer {
    ffi_entry(|| Ok(operation()))
}

fn ffi_entry(operation: impl FnOnce() -> Result<Value, CoreError>) -> PocketAnyDocBuffer {
    let outcome = catch_unwind(AssertUnwindSafe(operation));
    // A second barrier includes serde serialization, fallback construction,
    // Vec ownership transfer, and atomics. If even error serialization
    // panics, return the null descriptor; native wrappers map that safely.
    catch_unwind(AssertUnwindSafe(|| match outcome {
        Ok(Ok(value)) => serialize(&success(value)),
        Ok(Err(error)) => serialize(&failure(&error)),
        Err(_) => serialize(&failure(&CoreError::Internal)),
    }))
    .unwrap_or_else(|_| PocketAnyDocBuffer::empty())
}

fn serialize(value: &impl Serialize) -> PocketAnyDocBuffer {
    match serde_json::to_vec(value) {
        Ok(bytes) if bytes.len() <= MAX_RESPONSE_JSON_BYTES => make_buffer(bytes),
        _ => {
            let fallback = serde_json::to_vec(&failure(&CoreError::ResourceLimit(
                "max_response_json_bytes",
            )))
            .unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
            make_buffer(fallback)
        }
    }
}

fn make_buffer(mut bytes: Vec<u8>) -> PocketAnyDocBuffer {
    if bytes.is_empty() {
        return PocketAnyDocBuffer::empty();
    }
    let buffer = PocketAnyDocBuffer {
        ptr: bytes.as_mut_ptr(),
        len: bytes.len(),
        capacity: bytes.capacity(),
    };
    std::mem::forget(bytes);
    OUTSTANDING_BUFFERS.fetch_add(1, Ordering::Relaxed);
    buffer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy(buffer: &PocketAnyDocBuffer) -> Vec<u8> {
        // SAFETY: tests inspect a live buffer before returning its ownership.
        unsafe { slice::from_raw_parts(buffer.ptr, buffer.len).to_vec() }
    }

    #[test]
    fn allocation_and_free_are_balanced() {
        let before = OUTSTANDING_BUFFERS.load(Ordering::Relaxed);
        for _ in 0..128 {
            let buffer = pocket_anydoc_version();
            assert!(!buffer.ptr.is_null());
            assert!(copy(&buffer).starts_with(b"{\"ok\":true"));
            pocket_anydoc_buffer_free(buffer);
        }
        assert_eq!(OUTSTANDING_BUFFERS.load(Ordering::Relaxed), before);
    }

    #[test]
    fn panic_is_contained_in_error_envelope() {
        let buffer = ffi_entry(|| -> Result<Value, CoreError> { panic!("contained test panic") });
        let value: Value = serde_json::from_slice(&copy(&buffer)).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "native_failed");
        pocket_anydoc_buffer_free(buffer);
    }

    #[test]
    fn oversized_request_is_rejected_without_reading_pointer() {
        let engine = pocket_anydoc_engine_new();
        let buffer = pocket_anydoc_cancel(engine, ptr::dangling(), MAX_REQUEST_JSON_BYTES + 1);
        let value: Value = serde_json::from_slice(&copy(&buffer)).unwrap();
        assert_eq!(value["error"]["code"], "resource_limit");
        pocket_anydoc_buffer_free(buffer);
        pocket_anydoc_engine_free(engine);
    }

    #[test]
    fn public_header_declares_every_exported_abi_symbol() {
        let header = include_str!("../../include/pocket_anydoc.h");
        for symbol in [
            "pocket_anydoc_engine_new",
            "pocket_anydoc_engine_free",
            "pocket_anydoc_version",
            "pocket_anydoc_capabilities",
            "pocket_anydoc_prepare",
            "pocket_anydoc_select_context",
            "pocket_anydoc_materialize_asset",
            "pocket_anydoc_cancel",
            "pocket_anydoc_release",
            "pocket_anydoc_buffer_free",
        ] {
            assert!(header.contains(symbol), "public header omitted {symbol}");
        }

        let _: extern "C" fn(*mut PocketAnyDocEngine, *const u8, usize) -> PocketAnyDocBuffer =
            pocket_anydoc_materialize_asset;
        let _: extern "C" fn(PocketAnyDocBuffer) = pocket_anydoc_buffer_free;
    }
}
