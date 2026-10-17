//! Canonical display groups reuse the node dictionary, not a per-object table.
use super::node_store::NodeStore;
use std::{collections::HashMap, sync::Arc};

pub(crate) struct NameGroups<'a> {
    pub names: Vec<&'a Arc<str>>,
    slots: Vec<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed::node_store::NodeType;
    use std::sync::atomic::AtomicBool;
    #[test]
    fn actual_adapters_merge_equal_text_and_ignore_obsolete_slots() {
        let dir = tempfile::tempdir().unwrap();
        let mut memory = NodeStore::new();
        let cancel = AtomicBool::new(false);
        let mut sorter = crate::indexed::sorted_runs::Sorter::new(dir.path(), 32, true, &cancel).unwrap();
        for id in 0..5 { sorter.push(id).unwrap(); }
        let mut construction = NodeStore::construction(sorter.finish().unwrap(), dir.path(), &cancel).unwrap();
        for store in [&mut memory, &mut construction] {
            store.add_node(0, 0, 0, NodeType::SuperRoot, Arc::from("SuperRoot"));
            store.add_node(1, 0, 0, NodeType::Class, Arc::from("Owner"));
            store.add_node(2, 0, 8, NodeType::Instance, Arc::from("obsolete"));
            store.get_by_index_mut(2).class_name = Arc::from("Owner");
            store.add_node(3, 0, 16, NodeType::Instance, Arc::from("Owner"));
            store.add_node(4, 0, 24, NodeType::ObjectArray, Arc::from("Owner[]"));
        }
        let (_receipt, names) = crate::indexed::compact_nodes::write(&construction, dir.path(), &cancel).unwrap();
        let mapped = NodeStore::mapped(crate::indexed::compact_nodes::MappedNodes::map(dir.path(), names, construction.len(), &cancel).unwrap());
        for nodes in [&memory, &construction, &mapped] {
            let groups = NameGroups::new(nodes);
            assert_eq!(groups.at(nodes, 1), groups.at(nodes, 2));
            assert_eq!(groups.at(nodes, 2), groups.at(nodes, 3));
            assert_ne!(groups.at(nodes, 3), groups.at(nodes, 4));
            let shallow = crate::indexed::parse_metadata::shallow_histogram(nodes);
            assert_eq!(shallow.len(), 2);
            let owner = shallow.iter().find(|e| e.class_name == "Owner").unwrap();
            assert_eq!((owner.instance_count, owner.shallow_size), (2, 24));
        }
    }
}
impl<'a> NameGroups<'a> {
    pub fn new(nodes: &'a NodeStore) -> Self {
        Self::cancellable(nodes, &mut || false).expect("uncancellable dictionary grouping")
    }
    pub fn cancellable(nodes: &'a NodeStore, cancelled: &mut impl FnMut() -> bool) -> anyhow::Result<Self> {
        let mut names = Vec::new();
        let mut by_text = HashMap::new();
        let mut slots = Vec::with_capacity(nodes.name_count());
        for slot in 0..nodes.name_count() as u32 {
            if slot % 1024 == 0 { anyhow::ensure!(!cancelled(), "Analysis cancelled"); }
            let name = nodes.dictionary_name(slot);
            let group = *by_text.entry(name.as_ref()).or_insert_with(|| {
                let group = names.len() as u32;
                names.push(name);
                group
            });
            slots.push(group);
        }
        Ok(Self { names, slots })
    }
    pub fn at(&self, nodes: &NodeStore, node: u32) -> u32 {
        self.slots[nodes.name_slot_at(node) as usize]
    }
}
