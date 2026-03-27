//! Class metadata index for HPROF ClassDump records.
//!
//! Stores per-class information (instance size, superclass, field descriptors)
//! and resolves full field layouts by walking inheritance chains.

use std::collections::HashMap;
use std::sync::Arc;

use jvm_hprof::heap_dump::FieldType;

/// Descriptor for a single instance field within a class.
#[derive(Debug, Clone)]
pub struct FieldDescriptor {
    /// The field name (interned).
    pub name: Arc<str>,
    /// The HPROF field type.
    pub field_type: FieldType,
}

/// Metadata for a single class, collected from a ClassDump sub-record.
#[derive(Debug, Clone)]
pub struct ClassInfo {
    /// The human-readable class name (e.g. "java.lang.String").
    pub class_name: Arc<str>,
    /// Instance size in bytes as declared by the JVM.
    pub instance_size: u32,
    /// The superclass object ID, or `None` for `java.lang.Object`.
    pub super_class_id: Option<u64>,
    /// Instance field descriptors declared by this class (not inherited).
    pub field_descriptors: Vec<FieldDescriptor>,
}

/// An index mapping class object IDs to their metadata.
///
/// After all ClassDump records are inserted, call [`resolve_field_layouts`]
/// to walk inheritance chains and produce complete field layouts for each class.
#[derive(Debug, Clone)]
pub struct ClassIndex {
    inner: HashMap<u64, ClassInfo>,
    /// Resolved full field layouts (own + inherited), keyed by class object ID.
    /// Populated by `resolve_field_layouts()`.
    layouts: HashMap<u64, Vec<(Arc<str>, FieldType)>>,
}

impl ClassIndex {
    /// Creates an empty `ClassIndex`.
    pub fn new() -> Self {
        Self {
            inner: HashMap::new(),
            layouts: HashMap::new(),
        }
    }

    /// Creates an empty `ClassIndex` with the given capacity hint.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: HashMap::with_capacity(capacity),
            layouts: HashMap::with_capacity(capacity),
        }
    }

    /// Inserts class metadata for the given class object ID.
    pub fn insert(&mut self, class_obj_id: u64, info: ClassInfo) {
        self.inner.insert(class_obj_id, info);
    }

    /// Returns the class metadata for the given class object ID.
    pub fn get(&self, class_obj_id: u64) -> Option<&ClassInfo> {
        self.inner.get(&class_obj_id)
    }

    /// Returns the number of classes in the index.
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    /// Returns `true` if the index is empty.
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Returns the resolved field layout for a class (own fields + inherited),
    /// or `None` if layouts have not been resolved or the class is unknown.
    pub fn field_layout(&self, class_obj_id: u64) -> Option<&[(Arc<str>, FieldType)]> {
        self.layouts.get(&class_obj_id).map(|v| v.as_slice())
    }

    /// Returns a reference to the raw layouts map.
    pub fn layouts(&self) -> &HashMap<u64, Vec<(Arc<str>, FieldType)>> {
        &self.layouts
    }

    /// Resolves full field layouts by walking inheritance chains.
    ///
    /// For each class, the layout is: own fields first, then parent fields
    /// (matching the byte order produced by the HotSpot HPROF agent).
    ///
    /// Uses memoization so each class's layout is computed at most once.
    /// Detects and breaks cycles in the class hierarchy.
    pub fn resolve_field_layouts(&mut self) {
        let class_ids: Vec<u64> = self.inner.keys().copied().collect();

        for class_id in class_ids {
            if self.layouts.contains_key(&class_id) {
                continue;
            }

            // Walk up the chain to find the first already-resolved ancestor.
            let mut chain: Vec<u64> = Vec::new();
            let mut current_id = Some(class_id);
            let mut visited = std::collections::HashSet::new();

            while let Some(cid) = current_id {
                if !visited.insert(cid) {
                    // Cycle detected — break.
                    break;
                }
                if self.layouts.contains_key(&cid) {
                    break;
                }
                chain.push(cid);
                current_id = self
                    .inner
                    .get(&cid)
                    .and_then(|info| info.super_class_id)
                    .filter(|&id| id != 0);
            }

            // Build layouts from the deepest unresolved ancestor down to class_id.
            for i in (0..chain.len()).rev() {
                let cid = chain[i];
                let parent_layout = self
                    .inner
                    .get(&cid)
                    .and_then(|info| info.super_class_id)
                    .filter(|&id| id != 0)
                    .and_then(|pid| self.layouts.get(&pid));

                let own_fields: Vec<(Arc<str>, FieldType)> = self
                    .inner
                    .get(&cid)
                    .map(|info| {
                        info.field_descriptors
                            .iter()
                            .map(|fd| (fd.name.clone(), fd.field_type))
                            .collect()
                    })
                    .unwrap_or_default();

                let mut layout = Vec::with_capacity(
                    own_fields.len() + parent_layout.map_or(0, |p| p.len()),
                );
                layout.extend(own_fields);
                if let Some(parent) = parent_layout {
                    layout.extend_from_slice(parent);
                }
                self.layouts.insert(cid, layout);
            }
        }
    }
}

impl Default for ClassIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_class(
        name: &str,
        instance_size: u32,
        super_class_id: Option<u64>,
        fields: Vec<(&str, FieldType)>,
    ) -> ClassInfo {
        ClassInfo {
            class_name: Arc::from(name),
            instance_size,
            super_class_id,
            field_descriptors: fields
                .into_iter()
                .map(|(n, ft)| FieldDescriptor {
                    name: Arc::from(n),
                    field_type: ft,
                })
                .collect(),
        }
    }

    #[test]
    fn insert_and_get() {
        let mut ci = ClassIndex::new();
        let info = make_class("java.lang.Object", 16, None, vec![]);
        ci.insert(100, info);

        assert_eq!(ci.len(), 1);
        let got = ci.get(100).unwrap();
        assert_eq!(got.class_name.as_ref(), "java.lang.Object");
        assert_eq!(got.instance_size, 16);
        assert!(got.super_class_id.is_none());
    }

    #[test]
    fn resolve_simple_hierarchy() {
        let mut ci = ClassIndex::new();

        // Object (root)
        ci.insert(
            1,
            make_class("java.lang.Object", 16, None, vec![]),
        );

        // String extends Object, has 'value' (ObjectId) and 'hash' (Int)
        ci.insert(
            2,
            make_class(
                "java.lang.String",
                40,
                Some(1),
                vec![
                    ("value", FieldType::ObjectId),
                    ("hash", FieldType::Int),
                ],
            ),
        );

        ci.resolve_field_layouts();

        // Object has no fields
        let obj_layout = ci.field_layout(1).unwrap();
        assert!(obj_layout.is_empty());

        // String: own fields (value, hash) + parent fields (none)
        let str_layout = ci.field_layout(2).unwrap();
        assert_eq!(str_layout.len(), 2);
        assert_eq!(str_layout[0].0.as_ref(), "value");
        assert_eq!(str_layout[1].0.as_ref(), "hash");
    }

    #[test]
    fn resolve_three_level_hierarchy() {
        let mut ci = ClassIndex::new();

        ci.insert(
            1,
            make_class("A", 16, None, vec![("a_field", FieldType::Int)]),
        );
        ci.insert(
            2,
            make_class("B", 24, Some(1), vec![("b_field", FieldType::Long)]),
        );
        ci.insert(
            3,
            make_class("C", 32, Some(2), vec![("c_field", FieldType::ObjectId)]),
        );

        ci.resolve_field_layouts();

        let layout = ci.field_layout(3).unwrap();
        // C's own field, then B's field, then A's field
        assert_eq!(layout.len(), 3);
        assert_eq!(layout[0].0.as_ref(), "c_field");
        assert_eq!(layout[1].0.as_ref(), "b_field");
        assert_eq!(layout[2].0.as_ref(), "a_field");
    }

    #[test]
    fn resolve_handles_missing_parent() {
        let mut ci = ClassIndex::new();

        // Parent ID 999 is not in the index
        ci.insert(
            10,
            make_class("Orphan", 16, Some(999), vec![("x", FieldType::Boolean)]),
        );

        ci.resolve_field_layouts();

        let layout = ci.field_layout(10).unwrap();
        assert_eq!(layout.len(), 1);
        assert_eq!(layout[0].0.as_ref(), "x");
    }

    #[test]
    fn resolve_handles_cycle() {
        let mut ci = ClassIndex::new();

        // A -> B -> A (cycle)
        ci.insert(
            1,
            make_class("A", 16, Some(2), vec![("fa", FieldType::Int)]),
        );
        ci.insert(
            2,
            make_class("B", 16, Some(1), vec![("fb", FieldType::Int)]),
        );

        // Should not panic or loop forever
        ci.resolve_field_layouts();

        // Both should have some layout (exact contents depend on traversal order)
        assert!(ci.field_layout(1).is_some());
        assert!(ci.field_layout(2).is_some());
    }

    #[test]
    fn empty_index() {
        let ci = ClassIndex::new();
        assert!(ci.is_empty());
        assert_eq!(ci.len(), 0);
        assert!(ci.get(1).is_none());
        assert!(ci.field_layout(1).is_none());
    }
}
