//! Interned string table for HPROF UTF8 records.
//!
//! Maps HPROF string IDs to shared `Arc<str>` values, avoiding duplicate
//! allocations when the same string is referenced from multiple places.

use std::collections::HashMap;
use std::sync::Arc;

/// A table mapping HPROF string IDs to shared string values.
///
/// Built from UTF8 records during HPROF parsing. Each string is stored
/// once as `Arc<str>` so it can be cheaply cloned into class names,
/// field names, etc.
#[derive(Debug, Clone)]
pub struct StringTable {
    inner: HashMap<u64, Arc<str>>,
}

impl StringTable {
    /// Creates an empty `StringTable`.
    pub fn new() -> Self {
        Self {
            inner: HashMap::new(),
        }
    }

    /// Creates an empty `StringTable` with the given capacity hint.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: HashMap::with_capacity(capacity),
        }
    }

    /// Inserts a string with the given HPROF ID.
    pub fn insert(&mut self, id: u64, text: &str) {
        self.inner.insert(id, Arc::from(text));
    }

    /// Returns the string for the given HPROF ID, if present.
    pub fn get(&self, id: u64) -> Option<&Arc<str>> {
        self.inner.get(&id)
    }

    /// Returns the number of entries in the table.
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    /// Returns `true` if the table is empty.
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

impl Default for StringTable {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_get() {
        let mut st = StringTable::new();
        st.insert(1, "java/lang/String");
        st.insert(2, "value");

        assert_eq!(st.get(1).map(|s| s.as_ref()), Some("java/lang/String"));
        assert_eq!(st.get(2).map(|s| s.as_ref()), Some("value"));
        assert!(st.get(99).is_none());
    }

    #[test]
    fn len_and_empty() {
        let mut st = StringTable::new();
        assert!(st.is_empty());
        assert_eq!(st.len(), 0);

        st.insert(10, "hello");
        assert!(!st.is_empty());
        assert_eq!(st.len(), 1);
    }

    #[test]
    fn with_capacity_works() {
        let st = StringTable::with_capacity(1024);
        assert!(st.is_empty());
    }

    #[test]
    fn overwrite_replaces_value() {
        let mut st = StringTable::new();
        st.insert(1, "old");
        st.insert(1, "new");
        assert_eq!(st.get(1).map(|s| s.as_ref()), Some("new"));
        assert_eq!(st.len(), 1);
    }

    #[test]
    fn arc_sharing() {
        let mut st = StringTable::new();
        st.insert(1, "shared");
        let a = st.get(1).unwrap().clone();
        let b = st.get(1).unwrap().clone();
        // Both Arcs should point to the same allocation
        assert!(Arc::ptr_eq(&a, &b));
    }
}
