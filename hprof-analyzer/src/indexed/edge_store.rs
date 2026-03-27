//! CSR (Compressed Sparse Row) edge storage for the heap graph.
//!
//! Provides compact, cache-friendly edge storage with O(1) neighbor lookups.
//! Edges are first collected via `EdgeBuilder`, then sorted, deduplicated,
//! and compressed into the final `EdgeStore`.

/// Edge label constants (compact u8 representation).
pub mod label {
    pub const GC_ROOT: u8 = 0;
    pub const INSTANCE_FIELD: u8 = 1;
    pub const ARRAY_ELEMENT: u8 = 2;
    pub const CLASS_STATIC: u8 = 3;
    pub const SUPER_CLASS: u8 = 4;
    pub const CLASS_LOADER: u8 = 5;
    pub const UNKNOWN: u8 = 6;
}

/// Collects edges during parsing before building the CSR store.
#[derive(Debug)]
pub struct EdgeBuilder {
    /// (source_idx, target_idx, label_type)
    edges: Vec<(u32, u32, u8)>,
}

impl EdgeBuilder {
    /// Creates a new `EdgeBuilder`.
    pub fn new() -> Self {
        Self { edges: Vec::new() }
    }

    /// Creates a new `EdgeBuilder` with the given capacity hint.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            edges: Vec::with_capacity(capacity),
        }
    }

    /// Adds an edge from `src` to `dst` with the given label.
    pub fn add_edge(&mut self, src: u32, dst: u32, label: u8) {
        self.edges.push((src, dst, label));
    }

    /// Returns the number of collected edges.
    pub fn len(&self) -> usize {
        self.edges.len()
    }

    /// Returns `true` if no edges have been added.
    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }

    /// Sorts, deduplicates, and compresses edges into a CSR `EdgeStore`.
    ///
    /// Also builds the reverse CSR for backward traversal.
    pub fn build(mut self, node_count: usize) -> EdgeStore {
        // Use rayon parallel sort for large edge lists
        use rayon::slice::ParallelSliceMut;
        self.edges.par_sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

        // Deduplicate by (source, target), keeping the first label
        self.edges.dedup_by(|b, a| a.0 == b.0 && a.1 == b.1);

        let edge_count = self.edges.len();

        // Build forward CSR
        let mut offsets = vec![0u32; node_count + 1];
        let mut targets = Vec::with_capacity(edge_count);
        let mut labels = Vec::with_capacity(edge_count);

        for &(src, dst, lbl) in &self.edges {
            offsets[src as usize + 1] += 1;
            targets.push(dst);
            labels.push(lbl);
        }

        // Prefix sum for offsets
        for i in 1..=node_count {
            offsets[i] += offsets[i - 1];
        }

        // Build reverse CSR
        let mut reverse_offsets = vec![0u32; node_count + 1];
        for &(_, dst, _) in &self.edges {
            reverse_offsets[dst as usize + 1] += 1;
        }
        for i in 1..=node_count {
            reverse_offsets[i] += reverse_offsets[i - 1];
        }

        let mut reverse_targets = vec![0u32; edge_count];
        let mut write_pos = reverse_offsets.clone();
        for &(src, dst, _) in &self.edges {
            let pos = write_pos[dst as usize] as usize;
            reverse_targets[pos] = src;
            write_pos[dst as usize] += 1;
        }

        EdgeStore {
            offsets,
            targets,
            labels,
            reverse_offsets,
            reverse_targets,
        }
    }
}

impl Default for EdgeBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Compressed Sparse Row edge store with both forward and reverse adjacency.
#[derive(Debug, Clone)]
pub struct EdgeStore {
    /// Forward offsets: `offsets[i]..offsets[i+1]` indexes into `targets` / `labels`.
    offsets: Vec<u32>,
    /// Forward edge targets, packed.
    targets: Vec<u32>,
    /// Forward edge labels, parallel to `targets`.
    labels: Vec<u8>,
    /// Reverse offsets: `reverse_offsets[i]..reverse_offsets[i+1]` indexes into `reverse_targets`.
    reverse_offsets: Vec<u32>,
    /// Reverse edge sources, packed (for backward traversal).
    reverse_targets: Vec<u32>,
}

impl EdgeStore {
    /// Returns the target indices of all outgoing edges from `node_idx`.
    pub fn neighbors(&self, node_idx: u32) -> &[u32] {
        let start = self.offsets[node_idx as usize] as usize;
        let end = self.offsets[node_idx as usize + 1] as usize;
        &self.targets[start..end]
    }

    /// Returns the (targets, labels) slices for outgoing edges from `node_idx`.
    pub fn neighbor_labels(&self, node_idx: u32) -> (&[u32], &[u8]) {
        let start = self.offsets[node_idx as usize] as usize;
        let end = self.offsets[node_idx as usize + 1] as usize;
        (&self.targets[start..end], &self.labels[start..end])
    }

    /// Returns the source indices of all incoming edges to `node_idx`.
    pub fn reverse_neighbors(&self, node_idx: u32) -> &[u32] {
        let start = self.reverse_offsets[node_idx as usize] as usize;
        let end = self.reverse_offsets[node_idx as usize + 1] as usize;
        &self.reverse_targets[start..end]
    }

    /// Returns the total number of edges.
    pub fn edge_count(&self) -> usize {
        self.targets.len()
    }

    /// Returns the number of nodes this store was built for.
    pub fn node_count(&self) -> usize {
        if self.offsets.is_empty() {
            0
        } else {
            self.offsets.len() - 1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a small graph:
    ///   0 --GC_ROOT--> 1
    ///   0 --GC_ROOT--> 2
    ///   1 --INSTANCE_FIELD--> 3
    ///   2 --ARRAY_ELEMENT--> 3
    fn build_test_store() -> EdgeStore {
        let mut eb = EdgeBuilder::with_capacity(4);
        eb.add_edge(0, 1, label::GC_ROOT);
        eb.add_edge(0, 2, label::GC_ROOT);
        eb.add_edge(1, 3, label::INSTANCE_FIELD);
        eb.add_edge(2, 3, label::ARRAY_ELEMENT);
        eb.build(4)
    }

    #[test]
    fn forward_neighbors() {
        let store = build_test_store();
        assert_eq!(store.neighbors(0), &[1, 2]);
        assert_eq!(store.neighbors(1), &[3]);
        assert_eq!(store.neighbors(2), &[3]);
        assert!(store.neighbors(3).is_empty());
    }

    #[test]
    fn neighbor_labels() {
        let store = build_test_store();
        let (targets, labels) = store.neighbor_labels(0);
        assert_eq!(targets, &[1, 2]);
        assert_eq!(labels, &[label::GC_ROOT, label::GC_ROOT]);

        let (targets, labels) = store.neighbor_labels(1);
        assert_eq!(targets, &[3]);
        assert_eq!(labels, &[label::INSTANCE_FIELD]);
    }

    #[test]
    fn reverse_neighbors() {
        let store = build_test_store();
        // Node 3 is referenced by nodes 1 and 2
        let mut rev = store.reverse_neighbors(3).to_vec();
        rev.sort();
        assert_eq!(rev, vec![1, 2]);

        // Node 1 is referenced by node 0
        assert_eq!(store.reverse_neighbors(1), &[0]);

        // Node 0 has no incoming edges
        assert!(store.reverse_neighbors(0).is_empty());
    }

    #[test]
    fn edge_and_node_count() {
        let store = build_test_store();
        assert_eq!(store.edge_count(), 4);
        assert_eq!(store.node_count(), 4);
    }

    #[test]
    fn deduplication() {
        let mut eb = EdgeBuilder::new();
        eb.add_edge(0, 1, label::GC_ROOT);
        eb.add_edge(0, 1, label::INSTANCE_FIELD); // duplicate (src, dst)
        eb.add_edge(0, 2, label::GC_ROOT);
        let store = eb.build(3);

        // Should only have 2 unique edges
        assert_eq!(store.edge_count(), 2);
        assert_eq!(store.neighbors(0), &[1, 2]);
    }

    #[test]
    fn empty_graph() {
        let eb = EdgeBuilder::new();
        let store = eb.build(0);
        assert_eq!(store.edge_count(), 0);
        assert_eq!(store.node_count(), 0);
    }

    #[test]
    fn single_node_no_edges() {
        let eb = EdgeBuilder::new();
        let store = eb.build(1);
        assert_eq!(store.edge_count(), 0);
        assert_eq!(store.node_count(), 1);
        assert!(store.neighbors(0).is_empty());
        assert!(store.reverse_neighbors(0).is_empty());
    }

    #[test]
    fn builder_len() {
        let mut eb = EdgeBuilder::new();
        assert!(eb.is_empty());
        eb.add_edge(0, 1, 0);
        eb.add_edge(1, 2, 0);
        assert_eq!(eb.len(), 2);
        assert!(!eb.is_empty());
    }
}
