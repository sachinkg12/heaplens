//! Flat node array for indexed heap analysis.
//!
//! Stores all heap objects (instances, arrays, classes, GC roots) in a
//! compact `Vec<NodeRecord>` with O(1) index-based access and an
//! `id_to_index` map for HPROF-ID lookups.

use std::collections::HashMap;
use std::sync::Arc;

/// The type of a node in the heap graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum NodeType {
    SuperRoot = 0,
    GcRoot = 1,
    Class = 2,
    Instance = 3,
    ObjectArray = 4,
    PrimitiveArray = 5,
}

/// A single node record in the flat array.
///
/// Kept compact: fixed-size fields plus a shared class name pointer.
#[derive(Debug, Clone)]
pub struct NodeRecord {
    /// HPROF object ID (0 for SuperRoot).
    pub id: u64,
    /// Index into `ClassIndex` for this node's class (0 if N/A).
    pub class_index: u32,
    /// Shallow size in bytes.
    pub shallow_size: u64,
    /// The kind of node.
    pub node_type: NodeType,
    /// Human-readable class name (shared via `Arc`).
    pub class_name: Arc<str>,
}

/// A flat store of all nodes, supporting both index-based and ID-based access.
#[derive(Debug, Clone)]
pub struct NodeStore {
    nodes: Vec<NodeRecord>,
    id_to_index: HashMap<u64, u32>,
    mapped: Option<super::compact_nodes::MappedNodes>,
}

impl NodeStore {
    pub fn nodes_are_mapped(&self) -> bool {
        self.mapped.is_some()
    }
    pub(crate) fn try_with_capacity(capacity: usize) -> anyhow::Result<Self> {
        let mut store = Self::new();
        store.nodes.try_reserve_exact(capacity)?;
        store.id_to_index.try_reserve(capacity)?;
        Ok(store)
    }

    /// Creates an empty `NodeStore`.
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            id_to_index: HashMap::new(),
            mapped: None,
        }
    }

    /// Creates an empty `NodeStore` with the given capacity hint.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            nodes: Vec::with_capacity(capacity),
            id_to_index: HashMap::with_capacity(capacity),
            mapped: None,
        }
    }

    /// Adds a node and returns its index.
    ///
    /// If a node with the same `id` already exists, returns the existing index
    /// without inserting a duplicate.
    pub fn add_node(
        &mut self,
        id: u64,
        class_index: u32,
        shallow_size: u64,
        node_type: NodeType,
        class_name: Arc<str>,
    ) -> u32 {
        assert!(self.mapped.is_none(), "Mapped node storage is immutable");
        if let Some(&existing) = self.id_to_index.get(&id) {
            return existing;
        }
        let idx = self.nodes.len() as u32;
        self.nodes.push(NodeRecord {
            id,
            class_index,
            shallow_size,
            node_type,
            class_name,
        });
        self.id_to_index.insert(id, idx);
        idx
    }

    /// Looks up a node by HPROF object ID.
    pub fn get_by_id(&self, id: u64) -> Option<NodeRecord> {
        self.index_of(id).map(|idx| self.get_by_index(idx))
    }

    /// Returns the index for a given HPROF object ID, if present.
    pub fn index_of(&self, id: u64) -> Option<u32> {
        match &self.mapped {
            Some(nodes) => nodes.index_of(id),
            None => self.id_to_index.get(&id).copied(),
        }
    }

    /// Returns a node by its flat index.
    ///
    /// # Panics
    ///
    /// Panics if `index` is out of bounds.
    pub fn get_by_index(&self, index: u32) -> NodeRecord {
        match &self.mapped {
            Some(nodes) => nodes.get(index),
            None => self.nodes[index as usize].clone(),
        }
    }

    /// Returns a mutable reference to a node by its flat index.
    ///
    /// # Panics
    ///
    /// Panics if `index` is out of bounds.
    pub fn get_by_index_mut(&mut self, index: u32) -> &mut NodeRecord {
        assert!(self.mapped.is_none(), "Mapped node storage is immutable");
        &mut self.nodes[index as usize]
    }

    /// Returns the number of nodes.
    pub fn len(&self) -> usize {
        self.mapped
            .as_ref()
            .map_or(self.nodes.len(), |nodes| nodes.len())
    }

    /// Returns `true` if no nodes have been added.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Returns an iterator over all node records.
    pub fn iter(&self) -> impl Iterator<Item = NodeRecord> + '_ {
        (0..self.len()).map(|i| self.get_by_index(i as u32))
    }
    pub fn id_at(&self, index: u32) -> u64 {
        match &self.mapped {
            Some(nodes) => nodes.id_at(index),
            None => self.nodes[index as usize].id,
        }
    }
    pub fn shallow_at(&self, index: u32) -> u64 {
        match &self.mapped {
            Some(nodes) => nodes.shallow_at(index),
            None => self.nodes[index as usize].shallow_size,
        }
    }
    pub fn class_at(&self, index: u32) -> u32 {
        match &self.mapped {
            Some(nodes) => nodes.class_at(index),
            None => self.nodes[index as usize].class_index,
        }
    }
    pub fn name_at(&self, index: u32) -> &Arc<str> {
        match &self.mapped {
            Some(nodes) => nodes.name_at(index),
            None => &self.nodes[index as usize].class_name,
        }
    }
    pub fn kind_at(&self, index: u32) -> NodeType {
        match &self.mapped {
            Some(nodes) => nodes.kind_at(index),
            None => self.nodes[index as usize].node_type,
        }
    }
    pub(crate) fn mapped(nodes: super::compact_nodes::MappedNodes) -> Self {
        Self {
            nodes: Vec::new(),
            id_to_index: HashMap::new(),
            mapped: Some(nodes),
        }
    }
    pub(crate) fn validate_ids(
        &self,
        ids: impl Iterator<Item = u64>,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> anyhow::Result<()> {
        if let Some(nodes) = &self.mapped {
            return nodes.validate_ids(ids, cancel);
        }
        for id in ids {
            super::disk_edges::check(cancel)?;
            anyhow::ensure!(
                self.index_of(id).is_some(),
                "Invalid cached object metadata ID"
            );
        }
        Ok(())
    }
}

impl Default for NodeStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_get_by_index() {
        let mut store = NodeStore::new();
        let idx = store.add_node(
            100,
            0,
            64,
            NodeType::Instance,
            Arc::from("java.lang.String"),
        );
        assert_eq!(idx, 0);

        let node = store.get_by_index(idx);
        assert_eq!(node.id, 100);
        assert_eq!(node.shallow_size, 64);
        assert_eq!(node.node_type, NodeType::Instance);
        assert_eq!(node.class_name.as_ref(), "java.lang.String");
    }

    #[test]
    fn get_by_id() {
        let mut store = NodeStore::new();
        store.add_node(42, 0, 16, NodeType::GcRoot, Arc::from("Root"));

        let node = store.get_by_id(42).unwrap();
        assert_eq!(node.id, 42);
        assert!(store.get_by_id(999).is_none());
    }

    #[test]
    fn dedup_by_id() {
        let mut store = NodeStore::new();
        let idx1 = store.add_node(10, 0, 16, NodeType::GcRoot, Arc::from("Root"));
        let idx2 = store.add_node(10, 1, 32, NodeType::Instance, Arc::from("Foo"));
        assert_eq!(idx1, idx2);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn index_of() {
        let mut store = NodeStore::new();
        store.add_node(50, 0, 8, NodeType::PrimitiveArray, Arc::from("byte[]"));
        assert_eq!(store.index_of(50), Some(0));
        assert_eq!(store.index_of(51), None);
    }

    #[test]
    fn len_and_empty() {
        let mut store = NodeStore::new();
        assert!(store.is_empty());
        assert_eq!(store.len(), 0);

        store.add_node(1, 0, 8, NodeType::SuperRoot, Arc::from("SuperRoot"));
        assert!(!store.is_empty());
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn iter_all_nodes() {
        let mut store = NodeStore::with_capacity(3);
        store.add_node(1, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
        store.add_node(2, 0, 16, NodeType::Instance, Arc::from("Foo"));
        store.add_node(3, 0, 32, NodeType::ObjectArray, Arc::from("Foo[]"));

        let ids: Vec<u64> = store.iter().map(|n| n.id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }

    #[test]
    fn get_by_index_mut() {
        let mut store = NodeStore::new();
        store.add_node(1, 0, 0, NodeType::GcRoot, Arc::from("Root"));

        // Upgrade from GcRoot to Instance
        let node = store.get_by_index_mut(0);
        node.node_type = NodeType::Instance;
        node.shallow_size = 48;
        node.class_name = Arc::from("java.lang.Thread");

        let node = store.get_by_index(0);
        assert_eq!(node.node_type, NodeType::Instance);
        assert_eq!(node.shallow_size, 48);
        assert_eq!(node.class_name.as_ref(), "java.lang.Thread");
    }
}
