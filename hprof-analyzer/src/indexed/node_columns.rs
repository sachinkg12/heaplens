//! Mutable typed columns keep shared names at dictionary granularity, not per node.
use super::node_store::{NodeRecord, NodeType, NodeView};
use anyhow::Result;
use std::{collections::HashMap, sync::Arc};

#[derive(Clone, Debug, Default)]
pub(crate) struct Names {
    values: Vec<Arc<str>>,
    slots: HashMap<Arc<str>, u32>,
    identities: HashMap<(usize, usize), u32>,
}
impl Names {
    pub fn intern(&mut self, name: &Arc<str>) -> u32 {
        let identity = (name.as_ptr() as usize, name.len());
        if let Some(&slot) = self.identities.get(&identity) {
            return slot;
        }
        if let Some(&slot) = self.slots.get(name.as_ref()) {
            return slot;
        }
        let slot = u32::try_from(self.values.len()).expect("Node name dictionary overflow");
        self.values.push(name.clone());
        self.slots.insert(name.clone(), slot);
        // The dictionary retains this exact allocation, preventing pointer reuse.
        self.identities.insert(identity, slot);
        slot
    }
    pub fn get(&self, slot: u32) -> &Arc<str> {
        &self.values[slot as usize]
    }
    pub fn len(&self) -> usize {
        self.values.len()
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct MemoryNodes {
    ids: Vec<u64>,
    sizes: Vec<u64>,
    classes: Vec<u32>,
    names: Vec<u32>,
    kinds: Vec<NodeType>,
    dictionary: Names,
}
impl MemoryNodes {
    pub fn try_with_capacity(count: usize) -> Result<Self> {
        let mut value = Self::default();
        value.ids.try_reserve_exact(count)?;
        value.sizes.try_reserve_exact(count)?;
        value.classes.try_reserve_exact(count)?;
        value.names.try_reserve_exact(count)?;
        value.kinds.try_reserve_exact(count)?;
        Ok(value)
    }
    pub fn len(&self) -> usize {
        self.ids.len()
    }
    pub fn push(&mut self, node: NodeRecord) {
        let name = self.dictionary.intern(&node.class_name);
        self.ids.push(node.id);
        self.sizes.push(node.shallow_size);
        self.classes.push(node.class_index);
        self.names.push(name);
        self.kinds.push(node.node_type);
    }
    pub fn view(&self, index: u32) -> NodeView<'_> {
        let i = index as usize;
        NodeView {
            id: self.ids[i],
            shallow_size: self.sizes[i],
            class_index: self.classes[i],
            node_type: self.kinds[i],
            class_name: self.dictionary.get(self.names[i]),
        }
    }
    pub fn set(&mut self, index: u32, node: &NodeRecord) {
        let i = index as usize;
        assert_eq!(self.ids[i], node.id, "Node identity is immutable");
        self.sizes[i] = node.shallow_size;
        self.classes[i] = node.class_index;
        self.names[i] = self.dictionary.intern(&node.class_name);
        self.kinds[i] = node.node_type;
    }
    pub fn id_at(&self, index: u32) -> u64 {
        self.ids[index as usize]
    }
    pub fn shallow_at(&self, index: u32) -> u64 {
        self.sizes[index as usize]
    }
    pub fn class_at(&self, index: u32) -> u32 {
        self.classes[index as usize]
    }
    pub fn name_at(&self, index: u32) -> &Arc<str> {
        self.dictionary.get(self.names[index as usize])
    }
    pub fn name_slot_at(&self, index: u32) -> u32 { self.names[index as usize] }
    pub fn name_count(&self) -> usize { self.dictionary.len() }
    pub fn dictionary_name(&self, slot: u32) -> &Arc<str> { self.dictionary.get(slot) }
    pub fn kind_at(&self, index: u32) -> NodeType {
        self.kinds[index as usize]
    }
    #[cfg(test)]
    fn element_capacity_bytes(&self) -> usize {
        8 * (self.ids.capacity() + self.sizes.capacity())
            + 4 * (self.classes.capacity() + self.names.capacity())
            + self.kinds.capacity()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn columns_use_25_element_bytes_and_one_dictionary_name_per_class() {
        let mut nodes = MemoryNodes::try_with_capacity(10_000).unwrap();
        let name: Arc<str> = Arc::from("shared.Name");
        for id in 0..10_000 {
            nodes.push(NodeRecord {
                id,
                shallow_size: 24,
                class_index: 1,
                node_type: NodeType::Instance,
                class_name: name.clone(),
            });
        }
        assert_eq!(nodes.element_capacity_bytes(), 25 * 10_000);
        assert_eq!(nodes.dictionary.len(), 1);
        assert_eq!(Arc::strong_count(&name), 3); // caller + dictionary vector/key
        assert_eq!(nodes.view(9999).id, 9999);
    }
}
