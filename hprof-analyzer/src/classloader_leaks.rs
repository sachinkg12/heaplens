//! Backend-neutral policy for identifying classloader leak suspects.
//!
//! Parsers and dominator implementations remain backend-specific. This module
//! owns only the policy: the 5% classloader threshold, deterministic ranking,
//! and accumulation-point walk. Backends expose their storage through the
//! narrow `ClassloaderTree` adapter.

use std::collections::HashSet;
use std::hash::Hash;

use crate::LeakSuspect;

const CLASSLOADER_THRESHOLD_PERCENT: u64 = 5;
const MAX_CLASSLOADER_SUSPECTS: usize = 5;

pub(crate) trait ClassloaderTree {
    type Node: Copy + Eq + Hash;

    fn node_for_object_id(&self, object_id: u64) -> Option<Self::Node>;
    fn object_id(&self, node: Self::Node) -> u64;
    fn class_name(&self, node: Self::Node) -> String;
    fn retained_size(&self, node: Self::Node) -> u64;
    fn parent(&self, node: Self::Node) -> Option<Self::Node>;
    fn children(&self, node: Self::Node) -> Vec<Self::Node>;
}

#[derive(Clone, Debug)]
pub(crate) struct DetectedClassloader<Node> {
    pub node: Node,
    pub suspect: LeakSuspect,
}

/// Identifies significant classloaders using the established HeapLens legacy
/// semantics. The input IDs come from HPROF class definitions, not class-name
/// heuristics, so custom loader subclasses are handled without special cases.
pub(crate) fn detect_classloader_suspects<T: ClassloaderTree>(
    tree: &T,
    classloader_ids: &HashSet<u64>,
    reachable_heap_size: u64,
) -> Vec<DetectedClassloader<T::Node>> {
    if reachable_heap_size == 0 {
        return Vec::new();
    }

    let threshold_bytes = reachable_heap_size.saturating_mul(CLASSLOADER_THRESHOLD_PERCENT) / 100;
    let mut candidates = Vec::new();

    for &classloader_id in classloader_ids {
        if classloader_id == 0 {
            continue;
        }
        let Some(node) = tree.node_for_object_id(classloader_id) else {
            continue;
        };
        let retained_size = tree.retained_size(node);
        if retained_size == 0 || retained_size < threshold_bytes {
            continue;
        }

        let class_name = tree.class_name(node);
        let object_id = tree.object_id(node);
        if class_name.is_empty() || object_id == 0 {
            continue;
        }

        candidates.push((retained_size, object_id, node, class_name));
    }

    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));

    candidates
        .into_iter()
        .take(MAX_CLASSLOADER_SUSPECTS)
        .map(|(retained_size, object_id, node, class_name)| {
            let percentage = (retained_size as f64 / reachable_heap_size as f64) * 100.0;
            let accumulation_node = find_accumulation_point(tree, node);
            let accumulation_info = accumulation_node
                .filter(|&candidate| candidate != node)
                .map(|candidate| {
                    format!(
                        ". Memory accumulated in {} ({:.2} MB)",
                        tree.class_name(candidate),
                        tree.retained_size(candidate) as f64 / (1024.0 * 1024.0)
                    )
                })
                .unwrap_or_default();

            DetectedClassloader {
                node,
                suspect: LeakSuspect {
                    class_name: class_name.clone(),
                    object_id,
                    retained_size,
                    retained_percentage: percentage,
                    accumulation_point: accumulation_node
                        .filter(|&candidate| candidate != node)
                        .map(|candidate| tree.class_name(candidate)),
                    description: format!(
                        "Classloader {} retains {:.1}% of reachable heap ({:.2} MB){}",
                        class_name,
                        percentage,
                        retained_size as f64 / (1024.0 * 1024.0),
                        accumulation_info,
                    ),
                },
            }
        })
        .collect()
}

/// Returns true when `node` is the classloader itself or is dominated by one
/// of the selected classloader suspects.
pub(crate) fn is_covered_by_classloader<T: ClassloaderTree>(
    tree: &T,
    node: T::Node,
    classloader_nodes: &HashSet<T::Node>,
) -> bool {
    let mut current = node;
    let mut visited = HashSet::new();

    while visited.insert(current) {
        if classloader_nodes.contains(&current) {
            return true;
        }
        let Some(parent) = tree.parent(current) else {
            return false;
        };
        if parent == current {
            return false;
        }
        current = parent;
    }

    false
}

fn find_accumulation_point<T: ClassloaderTree>(tree: &T, start: T::Node) -> Option<T::Node> {
    let mut current = start;
    let mut current_retained = tree.retained_size(start);
    let mut visited = HashSet::new();
    visited.insert(current);

    loop {
        let largest_child = tree
            .children(current)
            .into_iter()
            .max_by_key(|&child| tree.retained_size(child));
        let Some(child) = largest_child else {
            return Some(current);
        };
        let child_retained = tree.retained_size(child);

        // Follow a nearly linear ownership chain. Stop where memory fans out,
        // which is the useful accumulation point for the user.
        if child_retained <= current_retained.saturating_mul(4) / 5 {
            return Some(current);
        }
        if !visited.insert(child) {
            return Some(current);
        }

        current = child;
        current_retained = child_retained;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct TestTree {
        by_id: HashMap<u64, usize>,
        ids: Vec<u64>,
        names: Vec<String>,
        retained: Vec<u64>,
        parents: Vec<Option<usize>>,
        children: Vec<Vec<usize>>,
    }

    impl ClassloaderTree for TestTree {
        type Node = usize;

        fn node_for_object_id(&self, object_id: u64) -> Option<Self::Node> {
            self.by_id.get(&object_id).copied()
        }

        fn object_id(&self, node: Self::Node) -> u64 {
            self.ids[node]
        }

        fn class_name(&self, node: Self::Node) -> String {
            self.names[node].clone()
        }

        fn retained_size(&self, node: Self::Node) -> u64 {
            self.retained[node]
        }

        fn parent(&self, node: Self::Node) -> Option<Self::Node> {
            self.parents[node]
        }

        fn children(&self, node: Self::Node) -> Vec<Self::Node> {
            self.children[node].clone()
        }
    }

    fn test_tree() -> TestTree {
        TestTree {
            by_id: [(10, 0), (20, 1), (30, 2), (40, 3)].into_iter().collect(),
            ids: vec![10, 20, 30, 40],
            names: vec![
                "Loader".into(),
                "LinearCache".into(),
                "Left".into(),
                "Right".into(),
            ],
            retained: vec![80, 70, 30, 30],
            parents: vec![None, Some(0), Some(1), Some(1)],
            children: vec![vec![1], vec![2, 3], vec![], vec![]],
        }
    }

    #[test]
    fn detects_loader_at_five_percent_and_ignores_invalid_ids() {
        let tree = test_tree();
        let ids = [0, 10, 999].into_iter().collect();
        let suspects = detect_classloader_suspects(&tree, &ids, 1600);

        assert_eq!(suspects.len(), 1);
        assert_eq!(suspects[0].suspect.object_id, 10);
        assert_eq!(suspects[0].suspect.retained_size, 80);
        assert_eq!(
            suspects[0].suspect.accumulation_point.as_deref(),
            Some("LinearCache")
        );
    }

    #[test]
    fn rejects_loader_below_five_percent() {
        let tree = test_tree();
        let ids = [10].into_iter().collect();
        assert!(detect_classloader_suspects(&tree, &ids, 1620).is_empty());
    }

    #[test]
    fn reports_classloader_coverage_for_loader_and_descendants_only() {
        let tree = test_tree();
        let classloaders = [0].into_iter().collect();

        assert!(is_covered_by_classloader(&tree, 0, &classloaders));
        assert!(is_covered_by_classloader(&tree, 3, &classloaders));
        assert!(!is_covered_by_classloader(&tree, 0, &HashSet::new()));
    }

    #[test]
    fn empty_heap_and_empty_loader_name_are_ignored() {
        let mut tree = test_tree();
        tree.names[0].clear();
        let ids = [10].into_iter().collect();

        assert!(detect_classloader_suspects(&tree, &ids, 0).is_empty());
        assert!(detect_classloader_suspects(&tree, &ids, 1000).is_empty());

        tree.names[0] = "Loader".into();
        tree.retained[0] = 0;
        assert!(detect_classloader_suspects(&tree, &ids, 1).is_empty());
    }

    #[test]
    fn generated_trees_match_simple_selection_and_coverage_oracles() {
        let mut random = 0x9e37_79b9_7f4a_7c15u64;

        for case in 0..2_000u64 {
            let node_count = (next_random(&mut random) % 63 + 2) as usize;
            let mut tree = TestTree::default();
            tree.ids.reserve(node_count);
            tree.names.reserve(node_count);
            tree.retained.reserve(node_count);
            tree.parents.reserve(node_count);
            tree.children.resize_with(node_count, Vec::new);

            for node in 0..node_count {
                let object_id = case * 100 + node as u64 + 1;
                tree.by_id.insert(object_id, node);
                tree.ids.push(object_id);
                tree.names.push(format!("Loader{node}"));
                tree.retained.push(next_random(&mut random) % 10_000 + 1);

                let parent = if node == 0 {
                    None
                } else {
                    Some((next_random(&mut random) % node as u64) as usize)
                };
                tree.parents.push(parent);
                if let Some(parent) = parent {
                    tree.children[parent].push(node);
                }
            }

            let classloader_ids: HashSet<u64> = tree
                .ids
                .iter()
                .copied()
                .filter(|_| next_random(&mut random) % 3 == 0)
                .collect();
            let reachable_heap_size = 100_000u64;

            let mut expected: Vec<(u64, u64)> = classloader_ids
                .iter()
                .filter_map(|object_id| {
                    let node = tree.node_for_object_id(*object_id)?;
                    let retained = tree.retained_size(node);
                    (retained >= 5_000).then_some((retained, *object_id))
                })
                .collect();
            expected.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
            expected.truncate(MAX_CLASSLOADER_SUSPECTS);

            let actual = detect_classloader_suspects(&tree, &classloader_ids, reachable_heap_size);
            let actual_pairs: Vec<(u64, u64)> = actual
                .iter()
                .map(|detected| (detected.suspect.retained_size, detected.suspect.object_id))
                .collect();
            assert_eq!(actual_pairs, expected);

            let selected_nodes: HashSet<usize> =
                actual.iter().map(|detected| detected.node).collect();
            for node in 0..node_count {
                let expected_coverage = simple_is_covered(&tree, node, &selected_nodes);
                assert_eq!(
                    is_covered_by_classloader(&tree, node, &selected_nodes),
                    expected_coverage
                );
            }
        }
    }

    fn simple_is_covered(tree: &TestTree, node: usize, classloader_nodes: &HashSet<usize>) -> bool {
        let mut current = Some(node);
        for _ in 0..=tree.ids.len() {
            let Some(candidate) = current else {
                return false;
            };
            if classloader_nodes.contains(&candidate) {
                return true;
            }
            current = tree.parents[candidate];
        }
        false
    }

    fn next_random(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *state
    }
}
