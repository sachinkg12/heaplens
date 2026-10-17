//! Analysis-local stage measurements. No global recorder or additional data pass.
use std::time::Instant;

pub(crate) struct StageTimer {
    stage: &'static str,
    started: Instant,
}
impl StageTimer {
    pub(crate) fn start(stage: &'static str) -> Self {
        Self { stage, started: Instant::now() }
    }
}
impl Drop for StageTimer {
    fn drop(&mut self) {
        log::info!("Analysis stage: {} elapsed_us={}", self.stage, self.started.elapsed().as_micros());
    }
}
