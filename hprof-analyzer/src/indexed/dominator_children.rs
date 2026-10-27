//! Flat child lists preserve node order without an allocation for every object.
use std::ops::Index;

#[derive(Debug, Default)]
pub struct DominatorChildren {
    offsets: Vec<u32>,
    targets: Vec<u32>,
}

impl DominatorChildren {
    pub(crate) fn empty(nodes: usize) -> Self {
        Self {
            offsets: vec![0; nodes + 1],
            targets: Vec::new(),
        }
    }

    pub(crate) fn from_parents(parents: &[u32]) -> Self {
        Self::cancellable(parents,&||false).expect("uncancelled children")
    }
    pub(crate) fn cancellable(parents:&[u32],cancelled:&impl Fn()->bool)->anyhow::Result<Self> {
        let mut offsets = vec![0u32; parents.len() + 1];
        for (i,&parent) in parents.iter().enumerate() {
            if i%4096==0 {anyhow::ensure!(!cancelled(),"Analysis cancelled");}
            if parent != u32::MAX {
                offsets[parent as usize + 1] += 1;
            }
        }
        for i in 1..offsets.len() {
            if i%4096==0 {anyhow::ensure!(!cancelled(),"Analysis cancelled");}
            offsets[i] += offsets[i - 1];
        }
        let count = *offsets.last().unwrap();
        let mut targets = vec![0; count as usize];
        // Use the prefix ends as insertion cursors, then restore them in place.
        // Reverse insertion leaves each parent's children in ascending node order.
        for (node, &parent) in parents.iter().enumerate().rev() {
            if node%4096==0 {anyhow::ensure!(!cancelled(),"Analysis cancelled");}
            if parent != u32::MAX {
                let cursor = &mut offsets[parent as usize + 1];
                *cursor -= 1;
                targets[*cursor as usize] = node as u32;
            }
        }
        offsets.copy_within(1.., 0);
        *offsets.last_mut().unwrap() = count;
        anyhow::ensure!(!cancelled(),"Analysis cancelled");Ok(Self { offsets, targets })
    }
}

impl Index<usize> for DominatorChildren {
    type Output = [u32];
    fn index(&self, node: usize) -> &[u32] {
        &self.targets[self.offsets[node] as usize..self.offsets[node + 1] as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_lists_match_nested_lists_and_use_eight_bytes_per_node_at_most() {
        for parents in [
            vec![],
            vec![u32::MAX],
            vec![u32::MAX, 0, 0, 1, 0, 3],
            (0..100_000)
                .map(|i| if i == 0 { u32::MAX } else { (i - 1) / 2 })
                .collect(),
        ] {
            let flat = DominatorChildren::from_parents(&parents);
            let mut nested = vec![Vec::new(); parents.len()];
            for (node, &parent) in parents.iter().enumerate() {
                if parent != u32::MAX {
                    nested[parent as usize].push(node as u32);
                }
            }
            for (node, expected) in nested.iter().enumerate() {
                assert_eq!(&flat[node], expected);
            }
            let bytes = 4 * (flat.offsets.capacity() + flat.targets.capacity());
            assert!(bytes <= 8 * parents.len() + 4);
        }
    }
}
