#![deny(unsafe_code)]

//! Bounded JSONL driver for the synthetic host document benchmark.
//!
//! Input lines are `{ "op": "prepare|select|release", "request": {...} }`.
//! Each output line is the ordinary owned engine envelope plus a measured
//! process `metrics.peakRssBytes` value. No source path or document content is
//! logged outside the transient ABI response consumed by the benchmark.

use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;

use pocket_anydoc::PocketAnyDocEngine;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_HOST_LINE_BYTES: usize = 68 * 1024;
const MAX_HOST_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
const SOURCE_CHANGED_ENVELOPE: &str = r#"{"ok":false,"error":{"code":"native_failed","message":"The source changed while it was being prepared","retryable":true}}"#;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostOperation {
    op: String,
    request: Value,
}

fn main() {
    if run(io::stdin().lock(), io::stdout().lock()).is_err() {
        std::process::exit(1);
    }
}

fn run(input: impl BufRead, output: impl Write) -> io::Result<()> {
    let engine = PocketAnyDocEngine::new();
    let mut reader = BufReader::new(input);
    let mut writer = BufWriter::new(output);
    let mut line = Vec::new();
    while read_bounded_line(&mut reader, &mut line)? {
        let response = match serde_json::from_slice::<HostOperation>(&line) {
            Ok(operation) => execute_operation(&engine, operation),
            Err(_) => engine.invoke_benchmark_json("", "{}"),
        };
        let mut envelope: Value = serde_json::from_str(&response)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid engine envelope"))?;
        let object = envelope
            .as_object_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "non-object envelope"))?;
        object.insert(
            "metrics".to_string(),
            json!({ "peakRssBytes": process_metrics::peak_rss_bytes()? }),
        );
        serde_json::to_writer(&mut writer, &envelope)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    Ok(())
}

fn execute_operation(engine: &PocketAnyDocEngine, mut operation: HostOperation) -> String {
    let expected_sha = match normalize_prepare_identity(&operation.op, &mut operation.request) {
        Ok(expected) => expected,
        Err(()) => return SOURCE_CHANGED_ENVELOPE.to_string(),
    };
    let Ok(request) = serde_json::to_string(&operation.request) else {
        return engine.invoke_benchmark_json("", "{}");
    };
    let response = engine.invoke_benchmark_json(&operation.op, &request);
    let Some(expected_sha) = expected_sha else {
        return response;
    };
    let Ok(envelope) = serde_json::from_str::<Value>(&response) else {
        return SOURCE_CHANGED_ENVELOPE.to_string();
    };
    if envelope["ok"] == true
        && envelope["data"]["contentSha256"].as_str() != Some(expected_sha.as_str())
    {
        if let Some(handle) = envelope["data"]["handle"].as_str() {
            let release = json!({"schemaVersion": 1, "handle": handle}).to_string();
            let _ = engine.invoke_benchmark_json("release", &release);
        }
        return SOURCE_CHANGED_ENVELOPE.to_string();
    }
    response
}

/// The benchmark manifest uses a SHA-256 string as `sourceIdentity`, while
/// mobile wrappers inject a stat identity object. Verify the synthetic file
/// independently, remove only that host-only string, then require the core's
/// post-read content hash to match before publishing the handle.
fn normalize_prepare_identity(operation: &str, request: &mut Value) -> Result<Option<String>, ()> {
    if operation != "prepare" {
        return Ok(None);
    }
    let object = request.as_object_mut().ok_or(())?;
    let Some(expected) = object.get("sourceIdentity").and_then(Value::as_str) else {
        return Ok(None);
    };
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(());
    }
    let expected = expected.to_string();
    let source = PathBuf::from(object.get("sourcePath").and_then(Value::as_str).ok_or(())?);
    let root = PathBuf::from(
        object
            .get("privateRoot")
            .and_then(Value::as_str)
            .ok_or(())?,
    );
    if fs::symlink_metadata(&source)
        .map_err(|_| ())?
        .file_type()
        .is_symlink()
    {
        return Err(());
    }
    let root = fs::canonicalize(root).map_err(|_| ())?;
    let source = fs::canonicalize(source).map_err(|_| ())?;
    if source == root || !source.starts_with(&root) {
        return Err(());
    }
    let metadata = fs::metadata(&source).map_err(|_| ())?;
    let declared = object
        .get("sourceSizeBytes")
        .and_then(Value::as_u64)
        .ok_or(())?;
    if !metadata.is_file() || metadata.len() != declared || declared > MAX_HOST_SOURCE_BYTES {
        return Err(());
    }
    let mut file = File::open(source).map_err(|_| ())?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut block = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut block).map_err(|_| ())?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > MAX_HOST_SOURCE_BYTES || total > declared {
            return Err(());
        }
        digest.update(&block[..read]);
    }
    if total != declared || format!("{:x}", digest.finalize()) != expected {
        return Err(());
    }
    object.remove("sourceIdentity");
    Ok(Some(expected))
}

fn read_bounded_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<bool> {
    line.clear();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        let content_len = newline.unwrap_or(take);
        if line.len().saturating_add(content_len) > MAX_HOST_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "host request too large",
            ));
        }
        line.extend_from_slice(&available[..content_len]);
        reader.consume(take);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(true);
        }
    }
}

/// The only unsafe code in the host runner: tiny OS queries for the process's
/// measured peak resident set. It is separate from document parsing and does
/// not dereference caller-controlled memory.
#[allow(unsafe_code)]
mod process_metrics {
    use std::io;

    #[cfg(windows)]
    pub(super) fn peak_rss_bytes() -> io::Result<u64> {
        use std::mem::size_of;
        use windows_sys::Win32::System::ProcessStatus::{
            K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..PROCESS_MEMORY_COUNTERS::default()
        };
        // SAFETY: GetCurrentProcess returns a process pseudo-handle and the
        // initialized output buffer has the exact size supplied to Win32.
        let succeeded =
            unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
        if succeeded == 0 {
            Err(io::Error::last_os_error())
        } else {
            u64::try_from(counters.PeakWorkingSetSize)
                .map_err(|_| io::Error::other("peak RSS does not fit u64"))
        }
    }

    #[cfg(unix)]
    pub(super) fn peak_rss_bytes() -> io::Result<u64> {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // SAFETY: getrusage initializes the complete rusage output object for
        // RUSAGE_SELF when it returns zero.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the successful call above initialized `usage`.
        let peak = unsafe { usage.assume_init() }.ru_maxrss;
        let peak = u64::try_from(peak).map_err(|_| io::Error::other("negative peak RSS"))?;
        #[cfg(target_os = "macos")]
        return Ok(peak);
        #[cfg(not(target_os = "macos"))]
        Ok(peak.saturating_mul(1024))
    }

    #[cfg(not(any(unix, windows)))]
    pub(super) fn peak_rss_bytes() -> io::Result<u64> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "peak RSS is unavailable on this host",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn release_request_returns_one_bounded_envelope_with_real_rss() {
        let input = Cursor::new(
            b"{\"op\":\"release\",\"request\":{\"schemaVersion\":1,\"scope\":\"all_cached\"}}\n",
        );
        let mut output = Vec::new();
        run(input, &mut output).unwrap();
        let envelope: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(envelope["ok"], true);
        assert!(envelope["metrics"]["peakRssBytes"].as_u64().unwrap() > 0);
        assert_eq!(output.iter().filter(|byte| **byte == b'\n').count(), 1);
    }

    #[test]
    fn oversized_line_is_rejected_before_json_allocation_grows_unbounded() {
        let input = Cursor::new(vec![b'x'; MAX_HOST_LINE_BYTES + 1]);
        let error = run(input, Vec::new()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn real_corpus_prepare_select_release_accepts_verified_sha_identity() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let source = root.join("pocket-ai/multilingual.csv");
        let bytes = fs::read(&source).unwrap();
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let engine = PocketAnyDocEngine::new();
        let prepared = execute_operation(
            &engine,
            HostOperation {
                op: "prepare".to_string(),
                request: json!({
                    "schemaVersion": 1,
                    "requestId": "host-real-prepare",
                    "sourcePath": source,
                    "privateRoot": root,
                    "sourceIdentity": sha,
                    "sourceSizeBytes": bytes.len(),
                }),
            },
        );
        let prepared: Value = serde_json::from_str(&prepared).unwrap();
        assert_eq!(prepared["ok"], true, "{prepared}");
        let handle = prepared["data"]["handle"].as_str().unwrap();
        assert!(!prepared.to_string().contains("sourcePath"));

        let selected = execute_operation(
            &engine,
            HostOperation {
                op: "select".to_string(),
                request: json!({
                    "schemaVersion": 1,
                    "requestId": "host-real-select",
                    "handle": handle,
                    "query": "ORCHID-742",
                    "maxChunks": 4,
                    "maxChars": 4_000,
                }),
            },
        );
        let selected: Value = serde_json::from_str(&selected).unwrap();
        assert_eq!(selected["ok"], true);
        assert!(
            selected["data"]["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|chunk| {
                    chunk["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("ORCHID-742"))
                })
        );

        let released = execute_operation(
            &engine,
            HostOperation {
                op: "release".to_string(),
                request: json!({"schemaVersion": 1, "handle": handle}),
            },
        );
        let released: Value = serde_json::from_str(&released).unwrap();
        assert_eq!(released["ok"], true);
        assert_eq!(released["data"]["releasedCount"], 1);
    }
}
