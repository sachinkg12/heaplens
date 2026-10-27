//! Class-level histogram aggregation over a dominator tree.
//!
//! Retained subtrees for objects of the same class can overlap. The class
//! retained size is therefore the sum of only the topmost same-class objects
//! in the dominator tree, following minimum-retained-size semantics.

use std::collections::HashMap;
use std::sync::Arc;

use crate::ClassHistogramEntry;

/// One histogram-eligible node in a dominator tree.
pub(crate) struct ClassHistogramSample<K = Arc<str>> {
    pub(crate) class_name: K,
    pub(crate) shallow_size: u64,
    pub(crate) retained_size: u64,
}

/// Narrow adapter implemented by each heap backend.
///
/// The aggregation policy stays independent of indexed or petgraph storage,
/// so another backend can participate without changing this component.
pub(crate) trait ClassHistogramTree {
    type Node: Copy;
    type Class: Clone;

    fn root(&self) -> Self::Node;
    fn children(&self, node: Self::Node) -> &[Self::Node];
    fn sample(&self, node: Self::Node) -> Option<ClassHistogramSample<Self::Class>>;
}

#[derive(Default, Clone)]
struct ClassTotals {
    instance_count: u64,
    shallow_size: u64,
    retained_size: u64,
}

#[derive(Default)]
struct NonOverlappingClassAccumulator {
    totals: HashMap<Arc<str>, ClassTotals>,
    active_ancestors: HashMap<Arc<str>, usize>,
}

impl NonOverlappingClassAccumulator {
    fn enter(&mut self, sample: ClassHistogramSample) -> Arc<str> {
        let class_name = sample.class_name;
        let is_topmost = !self.active_ancestors.contains_key(class_name.as_ref());

        let totals = self.totals.entry(class_name.clone()).or_default();
        totals.instance_count += 1;
        totals.shallow_size += sample.shallow_size;
        if is_topmost {
            totals.retained_size += sample.retained_size;
        }

        *self.active_ancestors.entry(class_name.clone()).or_default() += 1;
        class_name
    }

    fn exit(&mut self, class_name: &Arc<str>) {
        let remove = match self.active_ancestors.get_mut(class_name.as_ref()) {
            Some(depth) => {
                *depth -= 1;
                *depth == 0
            }
            None => {
                debug_assert!(false, "class-histogram traversal exited an inactive class");
                false
            }
        };
        if remove {
            self.active_ancestors.remove(class_name.as_ref());
        }
    }

    fn finish(self) -> Vec<ClassHistogramEntry> {
        debug_assert!(self.active_ancestors.is_empty());
        let mut entries: Vec<ClassHistogramEntry> = self
            .totals
            .into_iter()
            .map(|(class_name, totals)| ClassHistogramEntry {
                class_name: class_name.to_string(),
                instance_count: totals.instance_count,
                shallow_size: totals.shallow_size,
                retained_size: totals.retained_size,
            })
            .collect();
        entries.sort_by(|a, b| b.retained_size.cmp(&a.retained_size).then(a.class_name.cmp(&b.class_name)));
        entries
    }
}

trait Accumulator<K> {
    fn enter(&mut self, sample: ClassHistogramSample<K>) -> K;
    fn exit(&mut self, key: &K);
    fn finish(self) -> Vec<ClassHistogramEntry>;
}
impl Accumulator<Arc<str>> for NonOverlappingClassAccumulator {
    fn enter(&mut self, sample: ClassHistogramSample) -> Arc<str> { self.enter(sample) }
    fn exit(&mut self, key: &Arc<str>) { self.exit(key); }
    fn finish(self) -> Vec<ClassHistogramEntry> { self.finish() }
}

struct DenseAccumulator<'a> {
    names: &'a [&'a Arc<str>],
    totals: Vec<ClassTotals>,
    active: Vec<usize>,
}
impl Accumulator<u32> for DenseAccumulator<'_> {
    fn enter(&mut self, sample: ClassHistogramSample<u32>) -> u32 {
        let slot = sample.class_name as usize;
        let totals = &mut self.totals[slot];
        totals.instance_count += 1;
        totals.shallow_size += sample.shallow_size;
        if self.active[slot] == 0 { totals.retained_size += sample.retained_size; }
        self.active[slot] += 1;
        sample.class_name
    }
    fn exit(&mut self, key: &u32) { self.active[*key as usize] -= 1; }
    fn finish(self) -> Vec<ClassHistogramEntry> {
        debug_assert!(self.active.iter().all(|depth| *depth == 0));
        let mut entries: Vec<_> = self.totals.into_iter().zip(self.names).filter(|(t, _)| t.instance_count > 0)
            .map(|(t, name)| ClassHistogramEntry { class_name: name.to_string(), instance_count: t.instance_count,
                shallow_size: t.shallow_size, retained_size: t.retained_size }).collect();
        entries.sort_by(|a, b| b.retained_size.cmp(&a.retained_size).then(a.class_name.cmp(&b.class_name)));
        entries
    }
}

pub(crate) fn aggregate_dense_histogram<T: ClassHistogramTree<Class = u32>>(
    tree: &T, names: &[&Arc<str>],
) -> Vec<ClassHistogramEntry> {
    aggregate_with(tree, DenseAccumulator { names, totals: vec![ClassTotals::default(); names.len()], active: vec![0; names.len()] })
}
pub(crate) fn aggregate_dense_histogram_cancellable<T:ClassHistogramTree<Class=u32>>(tree:&T,names:&[&Arc<str>],cancelled:&impl Fn()->bool)->anyhow::Result<Vec<ClassHistogramEntry>> {
    aggregate_with_cancellable(tree,DenseAccumulator{names,totals:vec![ClassTotals::default();names.len()],active:vec![0;names.len()]},cancelled)
}

struct TraversalFrame<N, K> {
    node: N,
    next_child: usize,
    active_class: Option<K>,
}

/// Builds a class histogram without double-counting nested retained subtrees.
///
/// Traversal is iterative and its temporary memory is proportional to tree
/// depth rather than the total number of heap objects.
pub(crate) fn aggregate_class_histogram<T>(tree: &T) -> Vec<ClassHistogramEntry>
where
    T: ClassHistogramTree<Class = Arc<str>>,
{
    aggregate_with(tree, NonOverlappingClassAccumulator::default())
}

fn aggregate_with<T: ClassHistogramTree, A: Accumulator<T::Class>>(tree: &T, accumulator: A) -> Vec<ClassHistogramEntry> {
    aggregate_with_cancellable(tree,accumulator,&||false).expect("uncancelled histogram")
}
fn aggregate_with_cancellable<T:ClassHistogramTree,A:Accumulator<T::Class>>(tree:&T,mut accumulator:A,cancelled:&impl Fn()->bool)->anyhow::Result<Vec<ClassHistogramEntry>> {
    anyhow::ensure!(!cancelled(),"Analysis cancelled");
    let root = tree.root();
    let root_class = tree.sample(root).map(|sample| accumulator.enter(sample));
    let mut stack = vec![TraversalFrame {
        node: root,
        next_child: 0,
        active_class: root_class,
    }];

    while let Some(frame) = stack.last_mut() {
        anyhow::ensure!(!cancelled(),"Analysis cancelled");
        let children = tree.children(frame.node);
        if frame.next_child < children.len() {
            let child = children[frame.next_child];
            frame.next_child += 1;
            let child_class = tree.sample(child).map(|sample| accumulator.enter(sample));
            stack.push(TraversalFrame {
                node: child,
                next_child: 0,
                active_class: child_class,
            });
        } else {
            let completed = stack.pop().expect("traversal stack is non-empty");
            if let Some(class_name) = completed.active_class {
                accumulator.exit(&class_name);
            }
        }
    }

    anyhow::ensure!(!cancelled(),"Analysis cancelled");let result=accumulator.finish();anyhow::ensure!(!cancelled(),"Analysis cancelled");Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestTree {
        children: Vec<Vec<usize>>,
        samples: Vec<Option<ClassHistogramSample>>,
    }

    impl ClassHistogramTree for TestTree {
        type Node = usize;
        type Class = Arc<str>;

        fn root(&self) -> Self::Node {
            0
        }

        fn children(&self, node: Self::Node) -> &[Self::Node] {
            &self.children[node]
        }

        fn sample(&self, node: Self::Node) -> Option<ClassHistogramSample> {
            self.samples[node]
                .as_ref()
                .map(|sample| ClassHistogramSample {
                    class_name: sample.class_name.clone(),
                    shallow_size: sample.shallow_size,
                    retained_size: sample.retained_size,
                })
        }
    }

    fn sample(
        class_name: &str,
        shallow_size: u64,
        retained_size: u64,
    ) -> Option<ClassHistogramSample> {
        Some(ClassHistogramSample {
            class_name: Arc::from(class_name),
            shallow_size,
            retained_size,
        })
    }

    fn entry<'a>(entries: &'a [ClassHistogramEntry], class_name: &str) -> &'a ClassHistogramEntry {
        entries
            .iter()
            .find(|entry| entry.class_name == class_name)
            .expect("class entry")
    }

    #[test]
    fn nested_same_class_counts_outer_retained_subtree_once() {
        let tree = TestTree {
            children: vec![vec![1], vec![2], vec![]],
            samples: vec![None, sample("Cache", 100, 160), sample("Cache", 60, 60)],
        };

        let entries = aggregate_class_histogram(&tree);
        let cache = entry(&entries, "Cache");
        assert_eq!(cache.instance_count, 2);
        assert_eq!(cache.shallow_size, 160);
        assert_eq!(cache.retained_size, 160);
    }

    #[test]
    fn sibling_same_class_subtrees_are_both_counted() {
        let tree = TestTree {
            children: vec![vec![1, 2], vec![], vec![]],
            samples: vec![None, sample("Cache", 40, 40), sample("Cache", 60, 60)],
        };

        let entries = aggregate_class_histogram(&tree);
        assert_eq!(entry(&entries, "Cache").retained_size, 100);
    }

    #[test]
    fn mixed_classes_do_not_suppress_each_other() {
        let tree = TestTree {
            children: vec![vec![1], vec![2], vec![3], vec![]],
            samples: vec![
                None,
                sample("Cache", 10, 100),
                sample("Bucket", 20, 90),
                sample("Cache", 30, 70),
            ],
        };

        let entries = aggregate_class_histogram(&tree);
        assert_eq!(entry(&entries, "Cache").retained_size, 100);
        assert_eq!(entry(&entries, "Bucket").retained_size, 90);
    }

    #[test]
    fn generated_trees_match_simple_top_ancestor_oracle() {
        const CASES: usize = 10_000;
        let mut state = 0x4845_4150_4c45_4e53u64;

        for _ in 0..CASES {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let node_count = 2 + ((state >> 32) as usize % 63);
            let mut parents = vec![usize::MAX; node_count];
            let mut children = vec![Vec::new(); node_count];
            let mut samples = Vec::with_capacity(node_count);
            samples.push(None);

            for node in 1..node_count {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                let parent = (state >> 32) as usize % node;
                parents[node] = parent;
                children[parent].push(node);

                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                let class_name = format!("Class{}", (state >> 32) % 7);
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                let shallow_size = 1 + ((state >> 32) % 1024);
                samples.push(sample(&class_name, shallow_size, shallow_size));
            }

            let mut retained_sizes = vec![0u64; node_count];
            for node in (1..node_count).rev() {
                let own = samples[node].as_ref().unwrap().shallow_size;
                retained_sizes[node] += own;
                retained_sizes[parents[node]] += retained_sizes[node];
                samples[node].as_mut().unwrap().retained_size = retained_sizes[node];
            }

            let tree = TestTree { children, samples };
            let actual = aggregate_class_histogram(&tree);
            // Distinct Arc allocations with equal text must still be one class.
            struct NumericTree<'a>(&'a TestTree, &'a HashMap<&'a str, u32>);
            impl ClassHistogramTree for NumericTree<'_> {
                type Node = usize;
                type Class = u32;
                fn root(&self) -> usize { 0 }
                fn children(&self, node: usize) -> &[usize] { &self.0.children[node] }
                fn sample(&self, node: usize) -> Option<ClassHistogramSample<u32>> {
                    self.0.samples[node].as_ref().map(|s| ClassHistogramSample {
                        class_name: self.1[s.class_name.as_ref()], shallow_size: s.shallow_size, retained_size: s.retained_size,
                    })
                }
            }
            let mut names = Vec::new();
            let mut slots = HashMap::new();
            for sample in tree.samples.iter().flatten() {
                slots.entry(sample.class_name.as_ref()).or_insert_with(|| {
                    let slot = names.len() as u32; names.push(&sample.class_name); slot
                });
            }
            assert_eq!(aggregate_dense_histogram(&NumericTree(&tree, &slots), &names), actual);
            let mut expected: HashMap<Arc<str>, ClassTotals> = HashMap::new();

            for node in 1..node_count {
                let sample = tree.samples[node].as_ref().unwrap();
                let totals = expected.entry(sample.class_name.clone()).or_default();
                totals.instance_count += 1;
                totals.shallow_size += sample.shallow_size;

                let mut ancestor = parents[node];
                let mut has_same_class_ancestor = false;
                while ancestor != usize::MAX && ancestor != 0 {
                    if tree.samples[ancestor].as_ref().unwrap().class_name == sample.class_name {
                        has_same_class_ancestor = true;
                        break;
                    }
                    ancestor = parents[ancestor];
                }
                if !has_same_class_ancestor {
                    totals.retained_size += sample.retained_size;
                }
            }

            for (class_name, totals) in expected {
                let entry = entry(&actual, class_name.as_ref());
                assert_eq!(entry.instance_count, totals.instance_count);
                assert_eq!(entry.shallow_size, totals.shallow_size);
                assert_eq!(entry.retained_size, totals.retained_size);
            }
        }
    }
}
