//! Borrowed observations of one analysis. Never expose provisional retained sizes.
use crate::{ClassHistogramEntry, HeapSummary};
use serde_json::{json, Value};

pub enum Observation<'a> {
    Records { instances: usize, arrays: usize, classes: usize, roots: usize },
    Shallow { summary: &'a HeapSummary, histogram: &'a [ClassHistogramEntry] },
    Stage(&'static str),
}

impl Observation<'_> {
    /// Additive protocol payload: old clients can ignore `snapshot` safely.
    pub fn payload(&self) -> Value {
        match self {
            Self::Records { instances, arrays, classes, roots } => json!({
                "stage":"sizing", "snapshot": {"kind":"records", "complete":false,
                    "instances":instances,"arrays":arrays,"classes":classes,"roots":roots}
            }),
            Self::Shallow { summary, histogram } => {
                let mut summary = serde_json::to_value(summary).expect("serializable summary");
                // Phase 1's internal reachable total is a placeholder, not evidence.
                summary["reachable_heap_size"] = Value::Null;
                json!({"stage":"shallow_ready", "snapshot": {
                    "kind":"shallow", "summary":summary,
                    "class_histogram":histogram.iter().map(|entry| json!({
                        "class_name":entry.class_name,"instance_count":entry.instance_count,
                        "shallow_size":entry.shallow_size
                    })).collect::<Vec<_>>(),
                    "readiness":{"summary":"ready","shallow_histogram":"ready",
                        "retained":"not_calculated","references":"not_calculated","waste":"not_calculated"}
                }})
            }
            Self::Stage(stage) => json!({"stage":stage}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_are_explicitly_partial_and_never_claim_heap_sizes() {
        let value=Observation::Records {instances:10,arrays:2,classes:3,roots:4}.payload();
        assert_eq!(value["snapshot"]["complete"],false);
        assert!(value["snapshot"].get("reachable_heap_size").is_none());
    }
}
