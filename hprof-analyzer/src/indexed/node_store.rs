//! Flat node array for indexed heap analysis.
//!
//! Stores all heap objects (instances, arrays, classes, GC roots) in a
//! compact typed columns or immutable mapped columns with O(1) index access.
//! Memory mode uses a dynamic ID map; disk construction uses exact sorted IDs.

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

/// A borrowed class-name handle with copied scalar fields. Reading either owned
/// or mapped columns never increments the name's shared reference counter.
#[derive(Clone, Copy, Debug)]
pub struct NodeView<'a> {
    pub id: u64, pub class_index: u32, pub shallow_size: u64,
    pub node_type: NodeType, pub class_name: &'a Arc<str>,
}
impl NodeView<'_> {
    pub fn to_record(self) -> NodeRecord { NodeRecord { id: self.id, class_index: self.class_index,
        shallow_size: self.shallow_size, node_type: self.node_type, class_name: self.class_name.clone() } }
}

/// A flat store of all nodes, supporting both index-based and ID-based access.
#[derive(Debug)]
pub struct NodeStore {
    nodes: super::node_columns::MemoryNodes,
    id_to_index: HashMap<u64, u32>,
    mapped: Option<super::compact_nodes::MappedNodes>,
    construction: Option<super::construction_nodes::ConstructionNodes>,
    resource: Option<Arc<super::resource_lease::Lease>>,
}

/// Write-back guard keeps mutation explicit across owned and file-backed rows.
pub struct NodeMutation<'a> { store: &'a mut NodeStore, index: u32, value: NodeRecord }
impl std::ops::Deref for NodeMutation<'_> { type Target = NodeRecord;
    fn deref(&self) -> &NodeRecord { &self.value } }
impl std::ops::DerefMut for NodeMutation<'_> {
    fn deref_mut(&mut self) -> &mut NodeRecord { &mut self.value } }
impl Drop for NodeMutation<'_> {
    fn drop(&mut self) {
        if let Some(nodes) = &mut self.store.construction { nodes.set(self.index, &self.value); }
        else { self.store.nodes.set(self.index, &self.value); }
    }
}

impl NodeStore {
    pub fn nodes_are_mapped(&self) -> bool {
        self.mapped.is_some()
    }
    pub(crate) fn try_with_capacity(capacity: usize) -> anyhow::Result<Self> {
        let mut store = Self::new();
        store.nodes = super::node_columns::MemoryNodes::try_with_capacity(capacity)?;
        store.id_to_index.try_reserve(capacity)?;
        Ok(store)
    }

    /// Creates an empty `NodeStore`.
    pub fn new() -> Self {
        Self {
            nodes: super::node_columns::MemoryNodes::default(),
            id_to_index: HashMap::new(),
            mapped: None,
            construction: None,
            resource: None,
        }
    }

    /// Creates an empty `NodeStore` with the given capacity hint.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            nodes: super::node_columns::MemoryNodes::try_with_capacity(capacity).expect("Node column allocation failed"),
            id_to_index: HashMap::with_capacity(capacity),
            mapped: None,
            construction: None,
            resource: None,
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
        self.insert_record(NodeRecord { id, class_index, shallow_size, node_type, class_name }, false).0
    }

    /// One exact ID lookup. Only a preceding root placeholder may be upgraded;
    /// repeated definitions preserve the first record and its count/size.
    pub(crate) fn define_node(&mut self, id: u64, shallow_size: u64, node_type: NodeType, class_name: Arc<str>) -> (u32, bool) {
        self.insert_record(NodeRecord { id, class_index: 0, shallow_size, node_type, class_name }, true)
    }

    fn insert_record(&mut self, record: NodeRecord, upgrade_root: bool) -> (u32, bool) {
        assert!(self.mapped.is_none(), "Mapped node storage is immutable");
        if let Some(nodes) = &mut self.construction {
            return nodes.insert(&record, upgrade_root);
        }
        match self.id_to_index.entry(record.id) {
            std::collections::hash_map::Entry::Occupied(entry) => {
                let index = *entry.get();
                if upgrade_root && self.nodes.kind_at(index) == NodeType::GcRoot {
                    self.nodes.set(index, &record);
                    (index, true)
                } else { (index, false) }
            },
            std::collections::hash_map::Entry::Vacant(entry) => {
                let index = self.nodes.len() as u32;
                self.nodes.push(record);
                entry.insert(index);
                (index, true)
            }
        }
    }

    /// Looks up a node by HPROF object ID.
    pub fn get_by_id(&self, id: u64) -> Option<NodeView<'_>> {
        self.index_of(id).map(|idx| self.get_by_index(idx))
    }

    /// Returns the index for a given HPROF object ID, if present.
    pub fn index_of(&self, id: u64) -> Option<u32> {
        if let Some(nodes) = &self.construction { return nodes.index_of(id); }
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
    pub fn get_by_index(&self, index: u32) -> NodeView<'_> {
        if self.mapped.is_none() && self.construction.is_none() { return self.nodes.view(index); }
        NodeView { id: self.id_at(index), class_index: self.class_at(index),
            shallow_size: self.shallow_at(index), node_type: self.kind_at(index), class_name: self.name_at(index) }
    }

    /// Returns a mutable reference to a node by its flat index.
    ///
    /// # Panics
    ///
    /// Panics if `index` is out of bounds.
    pub fn get_by_index_mut(&mut self, index: u32) -> NodeMutation<'_> {
        assert!(self.mapped.is_none(), "Mapped node storage is immutable");
        let value = self.get_by_index(index).to_record();
        NodeMutation { store: self, index, value }
    }

    /// Returns the number of nodes.
    pub fn len(&self) -> usize {
        if let Some(nodes) = &self.construction { return nodes.len(); }
        self.mapped
            .as_ref()
            .map_or(self.nodes.len(), |nodes| nodes.len())
    }

    /// Returns `true` if no nodes have been added.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Returns an iterator over all node records.
    pub fn iter(&self) -> impl Iterator<Item = NodeView<'_>> + '_ {
        (0..self.len()).map(|i| self.get_by_index(i as u32))
    }
    pub fn id_at(&self, index: u32) -> u64 {
        if let Some(nodes) = &self.construction { return nodes.id_at(index); }
        match &self.mapped {
            Some(nodes) => nodes.id_at(index),
            None => self.nodes.id_at(index),
        }
    }
    pub fn shallow_at(&self, index: u32) -> u64 {
        if let Some(nodes) = &self.construction { return nodes.shallow_at(index); }
        match &self.mapped {
            Some(nodes) => nodes.shallow_at(index),
            None => self.nodes.shallow_at(index),
        }
    }
    pub fn class_at(&self, index: u32) -> u32 {
        if let Some(nodes) = &self.construction { return nodes.class_at(index); }
        match &self.mapped {
            Some(nodes) => nodes.class_at(index),
            None => self.nodes.class_at(index),
        }
    }
    pub fn name_at(&self, index: u32) -> &Arc<str> {
        if let Some(nodes) = &self.construction { return nodes.name_at(index); }
        match &self.mapped {
            Some(nodes) => nodes.name_at(index),
            None => self.nodes.name_at(index),
        }
    }
    pub(crate) fn name_slot_at(&self, index: u32) -> u32 {
        if let Some(nodes) = &self.construction { return nodes.name_slot_at(index); }
        self.mapped.as_ref().map_or_else(|| self.nodes.name_slot_at(index), |nodes| nodes.name_slot_at(index))
    }
    pub(crate) fn name_count(&self) -> usize {
        if let Some(nodes) = &self.construction { return nodes.name_count(); }
        self.mapped.as_ref().map_or_else(|| self.nodes.name_count(), |nodes| nodes.name_count())
    }
    pub(crate) fn dictionary_name(&self, slot: u32) -> &Arc<str> {
        if let Some(nodes) = &self.construction { return nodes.dictionary_name(slot); }
        self.mapped.as_ref().map_or_else(|| self.nodes.dictionary_name(slot), |nodes| nodes.dictionary_name(slot))
    }
    pub fn kind_at(&self, index: u32) -> NodeType {
        if let Some(nodes) = &self.construction { return nodes.kind_at(index); }
        match &self.mapped {
            Some(nodes) => nodes.kind_at(index),
            None => self.nodes.kind_at(index),
        }
    }
    pub(crate) fn mapped(nodes: super::compact_nodes::MappedNodes) -> Self {
        Self {
            nodes: super::node_columns::MemoryNodes::default(),
            id_to_index: HashMap::new(),
            mapped: Some(nodes),
            construction: None,
            resource: None,
        }
    }
    pub(crate) fn construction(ids: super::sorted_runs::MappedRows<u64>, directory: &std::path::Path, cancel: &std::sync::atomic::AtomicBool) -> anyhow::Result<Self> {
        let mut store = Self::new();
        store.construction = Some(super::construction_nodes::ConstructionNodes::new(ids, directory, cancel)?); Ok(store)
    }
    pub(crate) fn set_resource(&mut self, resource: Option<Arc<super::resource_lease::Lease>>) { self.resource = resource; }
    pub(crate) fn transfer_resource_to(&mut self, other: &mut Self) { other.resource = self.resource.take(); }
    pub(crate) fn has_construction_lookup(&self) -> bool { self.construction.is_some() }
    pub(crate) fn lookup_order_at(&self, rank: u32) -> u32 {
        self.construction.as_ref().unwrap().lookup_order_at(rank)
    }
    pub(crate) fn validate_construction(&self) -> anyhow::Result<()> {
        if let Some(nodes) = &self.construction { nodes.validate_complete()?; } Ok(())
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

impl NodeStore {
    pub(crate) fn mapped_id_order_index(&self, rank: u32) -> u32 {
        self.mapped.as_ref().expect("frozen node order").id_order_index(rank)
    }
}
impl Clone for NodeStore {
    fn clone(&self) -> Self {
        // Only private construction owns mutable maps; it is frozen before the
        // public load returns. Do not accidentally materialize a second catalog.
        assert!(self.construction.is_none(), "Mutable construction catalog cannot be cloned");
        Self { nodes: self.nodes.clone(), id_to_index: self.id_to_index.clone(),
            mapped: self.mapped.clone(), construction: None, resource: self.resource.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_lookup_definition_only_upgrades_root_placeholders() {
        let mut store = NodeStore::new();
        store.add_node(7, 0, 0, NodeType::GcRoot, Arc::from("root"));
        assert_eq!(store.define_node(7, 24, NodeType::Instance, Arc::from("Owner")), (0, true));
        assert_eq!(store.define_node(7, 99, NodeType::Class, Arc::from("duplicate")), (0, false));
        assert_eq!(store.define_node(1u64 << 40 | 7, 32, NodeType::PrimitiveArray, Arc::from("byte[]")), (1, true));
        assert_eq!(store.get_by_index(0).shallow_size, 24);
        assert_eq!(store.get_by_index(0).class_name.as_ref(), "Owner");
        assert_eq!(store.len(), 2);
    }

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
    fn memory_reads_borrow_shared_names_without_reference_count_churn() {
        let name: Arc<str> = Arc::from("shared.Name");
        let mut store = NodeStore::new();
        store.add_node(42, 0, 24, NodeType::Instance, name.clone());
        let owners = Arc::strong_count(&name);
        let node = store.get_by_index(0);
        assert!(Arc::ptr_eq(node.class_name, &name));
        assert_eq!(Arc::strong_count(&name), owners);
        assert_eq!(store.iter().map(|n| n.shallow_size).sum::<u64>(), 24);
        assert_eq!(Arc::strong_count(&name), owners);
    }

    #[test]
    fn get_by_index_mut() {
        let mut store = NodeStore::new();
        store.add_node(1, 0, 0, NodeType::GcRoot, Arc::from("Root"));

        // Upgrade from GcRoot to Instance
        let mut node = store.get_by_index_mut(0);
        node.node_type = NodeType::Instance;
        node.shallow_size = 48;
        node.class_name = Arc::from("java.lang.Thread");
        drop(node);

        let node = store.get_by_index(0);
        assert_eq!(node.node_type, NodeType::Instance);
        assert_eq!(node.shallow_size, 48);
        assert_eq!(node.class_name.as_ref(), "java.lang.Thread");
    }
}
