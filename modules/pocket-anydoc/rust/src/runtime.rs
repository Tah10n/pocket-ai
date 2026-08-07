//! Thread-local wall deadline for host-owned conversion loops.

use std::cell::Cell;
use std::time::{Duration, Instant};

use crate::error::CoreError;

thread_local! {
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

pub(crate) struct RuntimeGuard {
    previous: Option<Instant>,
}

pub(crate) fn install(duration: Duration) -> RuntimeGuard {
    let deadline = Instant::now()
        .checked_add(duration)
        .unwrap_or_else(Instant::now);
    let previous = DEADLINE.with(|slot| slot.replace(Some(deadline)));
    RuntimeGuard { previous }
}

pub(crate) fn checkpoint() -> Result<(), CoreError> {
    DEADLINE.with(|slot| {
        if slot
            .get()
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Err(CoreError::ResourceLimit("max_conversion_millis"))
        } else {
            Ok(())
        }
    })
}

impl Drop for RuntimeGuard {
    fn drop(&mut self) {
        DEADLINE.with(|slot| slot.set(self.previous.take()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_duration_deadline_is_deterministic_and_restored() {
        {
            let _guard = install(Duration::ZERO);
            assert!(matches!(
                checkpoint(),
                Err(CoreError::ResourceLimit("max_conversion_millis"))
            ));
        }
        checkpoint().unwrap();
    }
}
