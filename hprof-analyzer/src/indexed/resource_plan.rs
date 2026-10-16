//! Admission estimates cover overlapping phases, not only the edge-sort buffer.
//! They are conservative planning values, not a process RSS or OS memory limit.
use crate::hprof_sizing::RecordCounts;
use anyhow::{ensure, Result};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Plan {
    pub bytes: u64,
}
const MIB: u64 = 1024 * 1024;
impl Plan {
    pub fn from_counts(c: RecordCounts, disk: bool, sort_bytes: usize) -> Result<Self> {
        let nodes = c
            .node_capacity()?
            .checked_add(c.load_classes)
            .ok_or_else(|| anyhow::anyhow!("Node capacity overflow"))? as u64;
        let bodies = c
            .instances
            .checked_add(c.object_arrays)
            .ok_or_else(|| anyhow::anyhow!("Resource count overflow"))? as u64;
        let reference_capacity = c.reference_capacity()?;
        let edges = reference_capacity as u64;
        // Class tables/field layouts and UTF8 payloads are shared, not per object.
        let metadata = (c.strings as u64)
            .checked_mul(112)
            .and_then(|n| n.checked_add(c.string_bytes as u64))
            .and_then(|n| {
                (c.classes as u64)
                    .checked_mul(2048)
                    .and_then(|k| n.checked_add(k))
            })
            .ok_or_else(|| anyhow::anyhow!("Metadata capacity overflow"))?;
        // Waste candidates, array maps and lazily decoded string groupings are
        // workload-dependent. Reserve an allowance; report it as an estimate.
        let waste = (c.instances as u64)
            .checked_mul(32)
            .and_then(|n| {
                (c.primitive_arrays as u64)
                    .checked_mul(160)
                    .and_then(|k| n.checked_add(k))
            })
            .ok_or_else(|| anyhow::anyhow!("Waste capacity overflow"))?;
        // Memory nodes 25N, dynamic lookup allowance 40N, body locations 24B.
        // Disk catalogs are file backed; 8N is a mapped working-set allowance,
        // not a claim that mapped or dirty pages consume no RAM.
        let resident = if disk {
            nodes.checked_mul(8)
        } else {
            nodes
                .checked_mul(65)
                .and_then(|n| bodies.checked_mul(24).and_then(|b| n.checked_add(b)))
        }
        .ok_or_else(|| anyhow::anyhow!("Node capacity overflow"))?;
        // Include final CSR and its overlap with either bounded single-pass
        // staging or packed replay. Final CSR is 9E+8N; LT scratch/results
        // have their own per-node allowance below.
        let graph_peak = if disk {
            (sort_bytes as u64)
                .saturating_mul(2)
                .saturating_add(4 * MIB)
        } else {
            let fast = super::memory_edges::single_pass(reference_capacity);
            edges
                .checked_mul(if fast { 24 } else { 13 })
                .and_then(|e| {
                    nodes
                        .checked_mul(if fast { 12 } else { 8 })
                        .and_then(|n| e.checked_add(n))
                })
                .ok_or_else(|| anyhow::anyhow!("Graph capacity overflow"))?
        };
        let dominators = nodes
            .checked_mul(72)
            .and_then(|n| {
                if disk {
                    Some(n)
                } else {
                    edges.checked_mul(9).and_then(|e| n.checked_add(e))
                }
            })
            .ok_or_else(|| anyhow::anyhow!("Dominator capacity overflow"))?;
        let total = resident
            .checked_add(metadata)
            .and_then(|n| n.checked_add(waste))
            .and_then(|n| n.checked_add(graph_peak.max(dominators)))
            .and_then(|n| n.checked_add(128 * MIB))
            .ok_or_else(|| anyhow::anyhow!("Analysis capacity overflow"))?;
        // Twenty-five percent margin covers vector/hash capacity rounding,
        // bounded workers, allocator overhead and transient metadata.
        let bytes = total
            .checked_add(total / 4)
            .ok_or_else(|| anyhow::anyhow!("Analysis capacity overflow"))?;
        ensure!(bytes > 0, "Invalid resource plan");
        Ok(Self { bytes })
    }
    pub fn reopen(nodes: usize, metadata_bytes: u64) -> Result<Self> {
        // Mapped graph/node columns stay mapped. Metadata expands on read;
        // allow 4x serialized size plus dominator/workspace and lazy Waste.
        let bytes = (nodes as u64)
            .checked_mul(96)
            .and_then(|n| metadata_bytes.checked_mul(4).and_then(|m| n.checked_add(m)))
            .and_then(|n| n.checked_add(128 * MIB))
            .and_then(|n| n.checked_add(n / 4))
            .ok_or_else(|| anyhow::anyhow!("Reopen capacity overflow"))?;
        Ok(Self { bytes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn estimates_respond_to_record_shape_graph_and_mode_not_file_size() {
        let c = RecordCounts {
            instances: 80_000_000,
            object_arrays: 5_000_000,
            primitive_arrays: 8_000_000,
            reference_slots: 300_000_000,
            ..Default::default()
        };
        let memory = Plan::from_counts(c, false, MIB as usize).unwrap().bytes;
        let disk = Plan::from_counts(c, true, MIB as usize).unwrap().bytes;
        assert!(disk < memory);
        assert!(memory > 16_000_000_000);
        assert!(Plan::from_counts(
            RecordCounts {
                reference_slots: usize::MAX,
                ..c
            },
            false,
            1
        )
        .is_err());
        assert!(Plan::reopen(usize::MAX, u64::MAX).is_err());
    }
}
