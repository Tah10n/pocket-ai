//! Per-thread cooperative cancellation and work accounting installed by the
//! mobile host for one serial conversion. Normal crate callers need not set a
//! runtime; checkpoints become no-ops in that case.

use crate::ConvertError;
use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

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

/// Restores the previous per-thread runtime when the conversion returns or
/// unwinds.
pub struct RuntimeGuard {
    previous: Option<RuntimeState>,
}

/// Install cooperative state for the current thread and conversion.
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

impl Drop for RuntimeGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        STATE.with(|slot| {
            slot.replace(previous);
        });
    }
}

pub(crate) fn checkpoint() -> Result<(), ConvertError> {
    charge(0)
}

pub(crate) fn charge(units: usize) -> Result<(), ConvertError> {
    STATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(state) = slot.as_mut() else {
            return Ok(());
        };
        if state.cancelled.load(Ordering::Acquire) {
            return Err(ConvertError::ResourceLimit {
                limit: "cancelled",
                detail: "conversion cancelled by host".into(),
            });
        }
        if Instant::now() >= state.deadline {
            return Err(ConvertError::ResourceLimit {
                limit: "max_conversion_millis",
                detail: "conversion exceeded the host wall deadline".into(),
            });
        }
        state.work = state.work.saturating_add(units);
        state.progress.store(state.work, Ordering::Release);
        if state.work > state.maximum {
            return Err(ConvertError::ResourceLimit {
                limit: "max_work_units",
                detail: "conversion exceeded the host work budget".into(),
            });
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_and_work_limit_are_deterministic() {
        let token = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(AtomicUsize::new(0));
        let _guard = install(
            Arc::clone(&token),
            Arc::clone(&progress),
            2,
            Duration::from_secs(1),
        );
        charge(2).unwrap();
        assert_eq!(progress.load(Ordering::Acquire), 2);
        assert!(matches!(
            charge(1),
            Err(ConvertError::ResourceLimit {
                limit: "max_work_units",
                ..
            })
        ));
        token.store(true, Ordering::Release);
        assert!(matches!(
            checkpoint(),
            Err(ConvertError::ResourceLimit {
                limit: "cancelled",
                ..
            })
        ));
    }

    #[test]
    fn deadline_is_independent_from_cancellation() {
        let token = Arc::new(AtomicBool::new(false));
        let _guard = install(
            token,
            Arc::new(AtomicUsize::new(0)),
            usize::MAX,
            Duration::ZERO,
        );
        assert!(matches!(
            checkpoint(),
            Err(ConvertError::ResourceLimit {
                limit: "max_conversion_millis",
                ..
            })
        ));
    }
}
