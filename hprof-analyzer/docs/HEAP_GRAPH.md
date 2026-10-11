# HeapGraph Implementation

## Overview

The `HeapGraph` implementation provides a graph representation of the Java heap, modeling object reference relationships from HPROF files.

## Architecture

### NodeData Enum

Represents different types of nodes in the heap graph:

```rust
pub enum NodeData {
    SuperRoot,              // Synthetic root connecting to all GC roots
    Root,                   // GC root entry point
    Class,                  // Class definition
    Instance { id: u64, size: u32 },  // Object instance
    Array { id: u64, size: u32 },     // Array (object or primitive)
}
```

### HeapGraph Structure

```rust
pub struct HeapGraph {
    graph: Graph<NodeData, (), Directed>,
    id_to_node: HashMap<u64, NodeIndex>,
    super_root: NodeIndex,
}
```

- **graph**: The underlying petgraph structure
- **id_to_node**: Maps HPROF object/class IDs to graph node indices
- **super_root**: Index of the synthetic SuperRoot node

## Two-Pass Construction

### Pass 1: Node Identification

Scans the HPROF file to identify and create nodes for:

1. **Classes**: From `LOAD_CLASS` records
2. **Instances**: From `INSTANCE_DUMP` sub-records
3. **Arrays**: From `OBJECT_ARRAY` and `PRIMITIVE_ARRAY` sub-records
4. **GC Roots**: From various `GcRoot*` sub-records:
   - `GcRootUnknown`
   - `GcRootJniGlobal`
   - `GcRootJniLocalRef`
   - `GcRootJavaStackFrame`
   - `GcRootSystemClass`
   - `GcRootThreadObj`
   - `GcRootBusyMonitor`

Each node is added to the graph and its HPROF ID is mapped to a `NodeIndex`.

### Pass 2: Edge Creation

Scans the HPROF file again to find references and create edges:

1. **SuperRoot Connections**: Connects the synthetic `SuperRoot` node to all GC root nodes
2. **Instance References**: Parses instance field data to find object references
3. **Array References**: Parses array contents to find object references (for ObjectArray)
4. **Class References**: 
   - Superclass relationships
   - Class loader relationships

## GC Root Detection

The implementation detects all GC root types:

- **ROOT_JNI_GLOBAL**: `GcRootJniGlobal` - JNI global references
- **ROOT_JAVA_FRAME**: `GcRootJavaStackFrame` - Java stack frame roots
- **ROOT_JNI_LOCAL**: `GcRootJniLocalRef` - JNI local references
- **ROOT_SYSTEM_CLASS**: `GcRootSystemClass` - System class roots
- **ROOT_THREAD_OBJ**: `GcRootThreadObj` - Thread object roots
- **ROOT_BUSY_MONITOR**: `GcRootBusyMonitor` - Monitor roots
- **ROOT_UNKNOWN**: `GcRootUnknown` - Unknown root type

All GC roots are connected to the `SuperRoot` node, creating a single entry point into the object graph.

## Reference Extraction

### Instance References

Instance field data is parsed to extract object references. This is a simplified approach:

- Field data is scanned for potential object IDs
- IDs are extracted based on the HPROF file's ID size (32-bit or 64-bit)
- Non-zero IDs are treated as potential object references

**Note**: For accurate field parsing, class definitions with field descriptors would be needed. The current implementation uses a heuristic approach.

### Array References

- **ObjectArray**: Contents are object IDs, directly parsed
- **PrimitiveArray**: No object references (contains primitive values)

### Class References

- **Superclass**: `Class.super_class_obj_id()` → edge to superclass
- **Class Loader**: `Class.class_loader_obj_id()` → edge to class loader

## Usage Example

```rust
use hprof_analyzer::{HprofLoader, build_graph};
use std::path::PathBuf;

let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
let mmap = loader.map_file()?;

let graph = build_graph(&mmap[..])?;

println!("Graph: {} nodes, {} edges", 
         graph.node_count(), 
         graph.edge_count());
println!("SuperRoot node: {:?}", graph.super_root());

// Access the underlying graph for analysis
let petgraph = graph.graph();

// Find all nodes reachable from SuperRoot
use petgraph::visit::Dfs;
let mut dfs = Dfs::new(petgraph, graph.super_root());
while let Some(node_idx) = dfs.next(petgraph) {
    let node_data = &petgraph[node_idx];
    println!("Node: {:?}", node_data);
}
```

## Graph Analysis

The `HeapGraph` provides access to the underlying `petgraph::Graph` for analysis:

- **Reachability**: Find all objects reachable from GC roots
- **Dominators**: Find objects that dominate others
- **Cycles**: Detect reference cycles
- **Paths**: Find paths between objects
- **Statistics**: Node/edge counts, degree distributions

## Performance Characteristics

- **Zero-Copy**: Uses memory-mapped file access
- **Two-Pass**: Efficient single-pass node creation, single-pass edge creation
- **Lazy Parsing**: jvm-hprof defers parsing until needed
- **Scalable**: Handles large heaps efficiently

## Limitations

1. **Field Parsing**: Instance field parsing is heuristic-based. Accurate parsing requires class definitions with field descriptors.

2. **Size Calculation**: Instance sizes are approximate (based on field data length). Actual sizes include:
   - Object headers (8-16 bytes)
   - Alignment padding
   - Field data

3. **Primitive Arrays**: Primitive arrays don't contain object references, so no edges are created from them.

4. **Missing References**: Some references may be missed if field parsing heuristics don't detect them.

## Future Enhancements

- Accurate field parsing using class definitions
- Support for more GC root types
- Better size calculation
- Graph serialization/deserialization
- Incremental graph building
- Reference path analysis
