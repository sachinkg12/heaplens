//! Resolve a bounded, ID-ordered batch with exact membership and duplicate reuse.
//! Storage is deducted from the caller's existing edge-sort budget.
use super::node_store::NodeStore;
use anyhow::Result;
type Request = (u64, u32, u8);
pub(crate) struct ReferenceBatch {
    requests: Vec<Request>,
    limit: usize,
}
impl ReferenceBatch {
    pub fn new(budget: usize) -> Result<Self> {
        let limit = (budget / 8).min(16 * 1024) / std::mem::size_of::<Request>();
        let mut requests = Vec::new();
        requests.try_reserve_exact(limit)?;
        Ok(Self { requests, limit })
    }
    pub fn bytes(&self) -> usize {
        self.requests.capacity() * std::mem::size_of::<Request>()
    }
    pub fn push(
        &mut self,
        src: u32,
        id: u64,
        label: u8,
        nodes: &NodeStore,
        mut emit: impl FnMut(u32, u32, u8) -> Result<()>,
    ) -> Result<()> {
        if self.limit == 0 {
            if let Some(dst) = nodes.index_of(id) {
                emit(src, dst, label)?;
            }
            return Ok(());
        }
        self.requests.push((id, src, label));
        if self.requests.len() == self.limit {
            self.flush(nodes, emit)?;
        }
        Ok(())
    }
    pub fn flush(
        &mut self,
        nodes: &NodeStore,
        mut emit: impl FnMut(u32, u32, u8) -> Result<()>,
    ) -> Result<()> {
        self.requests.sort_unstable();
        let mut previous = None;
        let mut target = None;
        for &(id, src, label) in &self.requests {
            if previous != Some(id) {
                target = nodes.index_of(id);
                previous = Some(id);
            }
            if let Some(dst) = target {
                emit(src, dst, label)?;
            }
        }
        self.requests.clear();
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed::node_store::NodeType;
    use std::sync::Arc;
    #[test]
    fn sorted_batches_preserve_full_ids_unknowns_duplicates_labels_and_budget() {
        let mut nodes = NodeStore::new();
        for id in [0, u64::MAX, 1 << 48, 12] {
            nodes.add_node(id, 16, 0, NodeType::Instance, Arc::from("Owner"));
        }
        for budget in [12, 48, 256, 1024 * 1024] {
            let mut batch = ReferenceBatch::new(budget).unwrap();
            assert!(batch.bytes() <= budget / 8);
            let mut expected = Vec::new();
            let mut actual = Vec::new();
            for src in 0..4000 {
                for (label, id) in [u64::MAX, 7, 1 << 48, 0, 12, u64::MAX]
                    .into_iter()
                    .enumerate()
                {
                    if let Some(dst) = nodes.index_of(id) {
                        expected.push((src, dst, label as u8));
                    }
                    batch
                        .push(src, id, label as u8, &nodes, |s, t, l| {
                            actual.push((s, t, l));
                            Ok(())
                        })
                        .unwrap();
                }
            }
            batch
                .flush(&nodes, |s, t, l| {
                    actual.push((s, t, l));
                    Ok(())
                })
                .unwrap();
            actual.sort_unstable();
            expected.sort_unstable();
            assert_eq!(actual, expected);
            assert!(batch.requests.is_empty());
        }
    }
    #[test]
    fn sink_errors_are_not_swallowed() {
        let mut nodes = NodeStore::new();
        nodes.add_node(4, 0, 0, NodeType::Instance, Arc::from("Owner"));
        let mut batch = ReferenceBatch::new(4096).unwrap();
        batch.push(1, 4, 2, &nodes, |_, _, _| Ok(())).unwrap();
        assert!(batch
            .flush(&nodes, |_, _, _| anyhow::bail!("injected write failure"))
            .is_err());
    }
}
