//! Per-thread cooperative cancellation, work, and deadline accounting for
//! the bounded mobile host. Normal library callers install no runtime and the
//! checkpoints are no-ops.

use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use crate::PdfError;

struct RuntimeState {
    cancelled: Arc<AtomicBool>,
    progress: Arc<AtomicUsize>,
    work: usize,
    maximum: usize,
    deadline: Instant,
}

thread_local! {
    static STATE: RefCell<Option<RuntimeState>> = const { RefCell::new(None) };
}

/// Restores a previous nested runtime on drop, including unwinding paths.
pub struct RuntimeGuard {
    previous: Option<RuntimeState>,
}

/// Install bounded cooperative state for the current extraction thread.
pub fn install(
    cancelled: Arc<AtomicBool>,
    progress: Arc<AtomicUsize>,
    maximum_work_units: usize,
    maximum_duration: Duration,
) -> RuntimeGuard {
    let deadline = Instant::now()
        .checked_add(maximum_duration)
        .unwrap_or_else(Instant::now);
    let state = RuntimeState {
        cancelled,
        progress,
        work: 0,
        maximum: maximum_work_units.max(1),
        deadline,
    };
    let previous = STATE.with(|slot| slot.replace(Some(state)));
    RuntimeGuard { previous }
}

/// Observe cancellation/deadline without charging work.
pub(crate) fn checkpoint() -> Result<(), PdfError> {
    charge(0)
}

/// Observe cancellation/deadline and add deterministic parser work units.
pub(crate) fn charge(units: usize) -> Result<(), PdfError> {
    STATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(state) = slot.as_mut() else {
            return Ok(());
        };
        if state.cancelled.load(Ordering::Acquire) {
            return Err(PdfError::ResourceLimit("cancelled"));
        }
        if Instant::now() >= state.deadline {
            return Err(PdfError::ResourceLimit("max_conversion_millis"));
        }
        state.work = state.work.saturating_add(units);
        state.progress.store(state.work, Ordering::Release);
        if state.work > state.maximum {
            return Err(PdfError::ResourceLimit("max_work_units"));
        }
        Ok(())
    })
}

impl Drop for RuntimeGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        STATE.with(|slot| {
            slot.replace(previous);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_work_and_deadline_have_distinct_limits() {
        let token = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(AtomicUsize::new(0));
        {
            let _guard = install(
                Arc::clone(&token),
                Arc::clone(&progress),
                1,
                Duration::from_secs(1),
            );
            charge(1).unwrap();
            assert_eq!(progress.load(Ordering::Acquire), 1);
            assert!(matches!(charge(1), Err(PdfError::ResourceLimit("max_work_units"))));
            token.store(true, Ordering::Release);
            assert!(matches!(checkpoint(), Err(PdfError::ResourceLimit("cancelled"))));
        }
        token.store(false, Ordering::Release);
        let _guard = install(
            token,
            Arc::new(AtomicUsize::new(0)),
            usize::MAX,
            Duration::ZERO,
        );
        assert!(matches!(
            checkpoint(),
            Err(PdfError::ResourceLimit("max_conversion_millis"))
        ));
    }
}
