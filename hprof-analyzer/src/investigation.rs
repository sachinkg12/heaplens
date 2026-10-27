//! Strict, metadata-only reads for bounded AI investigation. No HPROF scan or query execution.
use anyhow::{bail, ensure, Result};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub const MAX_ROWS: usize = 32;
pub const MAX_NODES: usize = 4096;
pub const MAX_EDGES: usize = 16384;
pub const MAX_DEPTH: usize = 32;
pub const MAX_MILLIS: u64 = 2000;
pub const MAX_BYTES: usize = 65536;

#[derive(Clone, Copy, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Object,
    Fields,
    Outbound,
    Referrers,
    Children,
    RootPath,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub operation: Operation,
    pub object_id: String,
}
impl Request {
    pub fn object_id(&self) -> Result<u64> {
        ensure!(
            !self.object_id.is_empty()
                && self.object_id.len() <= 20
                && self.object_id.bytes().all(|b| b.is_ascii_digit())
                && !self.object_id.starts_with('0'),
            "Expected a positive exact decimal object ID"
        );
        Ok(self.object_id.parse()?)
    }
}

pub struct Budget {
    pub cancelled: Arc<AtomicBool>,
    pub deadline: Instant,
    pub nodes: usize,
    pub edges: usize,
}
impl Budget {
    pub fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            cancelled,
            deadline: Instant::now() + Duration::from_millis(MAX_MILLIS),
            nodes: 0,
            edges: 0,
        }
    }
    pub fn check(&self) -> Result<()> {
        ensure!(
            !self.cancelled.load(Ordering::Relaxed),
            "Investigation cancelled"
        );
        ensure!(
            Instant::now() < self.deadline,
            "Investigation deadline exceeded"
        );
        Ok(())
    }
    pub fn node(&mut self) -> Result<()> {
        self.check()?;
        if self.nodes >= MAX_NODES {
            bail!("Investigation node budget exhausted");
        }
        self.nodes += 1;
        Ok(())
    }
    pub fn edge(&mut self) -> Result<()> {
        self.check()?;
        if self.edges >= MAX_EDGES {
            bail!("Investigation edge budget exhausted");
        }
        self.edges += 1;
        Ok(())
    }
}

pub fn name(value: &str) -> String {
    value.chars().take(256).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_and_schema_reject_rounded_or_model_added_parameters() {
        for value in ["0", "01", "-1", "1.5", "18446744073709551616"] {
            let r = Request {
                operation: Operation::Object,
                object_id: value.into(),
            };
            assert!(r.object_id().is_err());
        }
        assert_eq!(
            Request {
                operation: Operation::Object,
                object_id: u64::MAX.to_string()
            }
            .object_id()
            .unwrap(),
            u64::MAX
        );
        assert!(serde_json::from_str::<Request>(
            r#"{"operation":"object","object_id":9007199254740993}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Request>(
            r#"{"operation":"execute_query","object_id":"1"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Request>(
            r#"{"operation":"object","object_id":"1","query":"SELECT *"}"#
        )
        .is_err());
    }
    #[test]
    fn cancellation_deadline_and_work_limits_are_enforced() {
        let c = Arc::new(AtomicBool::new(false));
        let mut b = Budget::new(c.clone());
        b.nodes = MAX_NODES;
        assert!(b.node().is_err());
        b.edges = MAX_EDGES;
        assert!(b.edge().is_err());
        c.store(true, Ordering::Relaxed);
        assert!(b.check().is_err());
        c.store(false, Ordering::Relaxed);
        b.deadline = Instant::now();
        assert!(b.check().is_err());
        assert_eq!(name(&"é".repeat(400)).chars().count(), 256);
    }
}
