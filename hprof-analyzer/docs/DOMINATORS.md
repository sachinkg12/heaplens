# Dominator Analysis and Retained Size Calculation

## Overview

The `calculate_dominators` function computes the dominator tree of the heap graph and calculates retained sizes for all objects, returning the top 50 objects sorted by retained size.

## Dominator Tree

A **dominator** of a node N is a node D such that all paths from the root (SuperRoot) to N pass through D. The **immediate dominator** is the unique dominator that is closest to N.

The dominator tree is computed using `petgraph::algo::dominators::simple_fast`, which implements the Lengauer-Tarjan algorithm.

### Why Dominators?

In heap analysis, dominators help identify:
- **Retention**: If node A dominates node B, removing A makes B unreachable
- **Memory ownership**: The dominator "owns" the memory of its dominated nodes
- **Garbage collection**: Objects are only collectible if their dominator is collectible

## Retained Size Calculation

**Retained size** is the amount of memory that would be freed if an object were garbage collected. It includes:

1. **Shallow size**: The object's own memory footprint
2. **Retained sizes of dominated objects**: All memory that would become unreachable

### Formula

```
Retained Size(N) = Shallow Size(N) + Sum(Retained Size of all children of N in Dominator Tree)
```

### Algorithm

The implementation uses an **iterative bottom-up traversal**:

1. **Initialize**: Set all nodes' retained size to their shallow size
2. **Build children map**: For each node, find all nodes it dominates (its children in the dominator tree)
3. **Bottom-up processing**: Repeatedly process nodes whose children are all processed:
   - Start with leaf nodes (nodes with no children in dominator tree)
   - Process nodes level by level from leaves to root
   - For each node: `retained = shallow + sum(children's retained sizes)`
4. **Convergence**: The algorithm converges when all nodes are processed

## ObjectReport Structure

```rust
pub struct ObjectReport {
    pub object_id: u64,           // HPROF object ID (0 for non-objects)
    pub node_type: String,         // "SuperRoot", "Root", "Class", "Instance", or "Array"
    pub shallow_size: u64,         // Object's own size in bytes
    pub retained_size: u64,        // Total retained size in bytes
    pub node_index: NodeIndex,     // Graph node index
}
```

## Usage Example

```rust
use hprof_analyzer::{HprofLoader, build_graph, calculate_dominators};
use std::path::PathBuf;

let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
let mmap = loader.map_file()?;
let graph = build_graph(&mmap[..])?;

// Calculate dominators and get top 50 objects
let top_objects = calculate_dominators(&graph)?;

// Print results
for (i, report) in top_objects.iter().enumerate() {
    println!("{}. ID={}, Type={}, Shallow={} bytes, Retained={} bytes ({:.2} MB)",
             i + 1,
             report.object_id,
             report.node_type,
             report.shallow_size,
             report.retained_size,
             report.retained_size as f64 / (1024.0 * 1024.0));
}
```

## Output

The function returns a `Vec<ObjectReport>` containing the top 50 objects sorted by retained size (descending). Objects with the same retained size are sorted by object ID.

## Performance

- **Time Complexity**: O(n log n) for dominator calculation, O(n) for retained size calculation
- **Space Complexity**: O(n) for storing dominator tree and sizes
- **Scalability**: Efficient for large heaps (millions of objects)

## Limitations

1. **Shallow Size Approximation**: Instances and arrays use the shared estimated JVM layout, including headers, inferred reference widths and alignment. Hidden VM fields, class metadata and special padding are excluded. See [SHALLOW_SIZES.md](SHALLOW_SIZES.md) for assumptions and validation.

2. **Field Parsing**: Instance field parsing is heuristic-based. Accurate parsing would require class definitions with field descriptors.

3. **Top 50 Limit**: Only the top 50 objects are returned. To get all objects, modify the function to return all reports.

## Use Cases

- **Memory Leak Detection**: Objects with high retained size that shouldn't be retained
- **Memory Optimization**: Identify objects consuming the most memory
- **Heap Analysis**: Understand memory ownership and retention patterns
- **Performance Tuning**: Focus optimization efforts on high-retained-size objects

## Algorithm Details

### Dominator Calculation

Uses the Lengauer-Tarjan algorithm via `petgraph::algo::dominators::simple_fast`:
- Efficient O(n log n) algorithm
- Handles large graphs well
- Returns immediate dominator for each node

### Retained Size Calculation

Iterative bottom-up approach:
- Processes nodes whose children are all processed
- Guarantees correct order (children before parents)
- Converges in at most n iterations (where n = number of nodes)
- Handles cycles gracefully (though dominator trees are acyclic)

## Example Output

```
1. ID=123456, Type=Instance, Shallow=1024 bytes, Retained=1048576 bytes (1.00 MB)
2. ID=234567, Type=Array, Shallow=512 bytes, Retained=524288 bytes (0.50 MB)
3. ID=345678, Type=Instance, Shallow=256 bytes, Retained=262144 bytes (0.25 MB)
...
```

## Future Enhancements

- Support for filtering by object type
- Support for custom top-N limit
- Export to CSV/JSON format
- Visualization of dominator tree
- Incremental updates for dynamic analysis
