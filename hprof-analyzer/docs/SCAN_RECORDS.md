# scan_records Implementation

## Overview

The `scan_records` function implements a zero-copy scanner for HPROF files that iterates over records and collects statistics.

## Implementation Details

### Function Signature

```rust
pub fn scan_records(data: &[u8]) -> Result<HprofStatistics>
```

### Zero-Copy Processing

The function leverages zero-copy features:

1. **Memory-Mapped Input**: Takes `&[u8]` slice (typically from `Mmap`)
2. **Lazy Parsing**: `jvm-hprof::parse_hprof()` only parses the header
3. **Deferred Record Parsing**: `records_iter()` provides an iterator that parses on-demand
4. **Direct Memory Access**: All data access happens directly from the mapped memory
5. **No Intermediate Buffers**: No copying of data during iteration

### Visitor Pattern / Match Loop

The implementation uses a **match loop** pattern (similar to Visitor):

1. **First Pass**: Iterate over all records, match on `RecordTag::LoadClass`
2. **Second Pass**: Iterate over records again, match on `RecordTag::HeapDump`/`HeapDumpSegment`
3. **Sub-Record Matching**: Within heap dump segments, match on `SubRecord::Instance`

### Statistics Collected

- **Total Classes**: Count of `LOAD_CLASS` records
- **Total Objects**: Count of `INSTANCE_DUMP` sub-records
- **Total Heap Size**: Approximate size based on instance field data lengths

### Endianness Handling

The `jvm-hprof` crate handles endianness automatically:

- HPROF files use **big-endian** (network byte order)
- All parse methods (`parse_hprof`, `as_load_class`, etc.) handle conversion internally
- No manual byte swapping required
- ID size (32-bit vs 64-bit) is read from the header

### Usage Example

```rust
use hprof_analyzer::{HprofLoader, scan_records};
use std::path::PathBuf;

let loader = HprofLoader::new(PathBuf::from("heap.hprof"));
let mmap = loader.map_file()?;

let stats = scan_records(&mmap[..])?;
stats.print();
```

### Output Format

The `HprofStatistics::print()` method outputs:

```
HPROF Statistics:
  Total Classes (LOAD_CLASS): 1234
  Total Objects (INSTANCE_DUMP): 567890
  Total Heap Size: 123456789 bytes (117.74 MB)
```

### Performance Characteristics

- **Memory Efficient**: Zero-copy means no additional memory allocation
- **Lazy Loading**: OS pages loaded on-demand via page faults
- **Single Pass**: Each record type is scanned in one pass
- **Scalable**: Handles multi-GB HPROF files efficiently

### Error Handling

The function returns `Result<HprofStatistics>` and handles:

- Invalid HPROF header format
- Corrupted record data
- Parsing failures
- All errors are wrapped with context using `anyhow`

### Heap Size Calculation

**Note**: The heap size calculation is approximate:

- Uses instance field data length as a proxy
- Does not include:
  - Object headers (8-16 bytes per object)
  - Alignment padding
  - Array overhead
- For accurate size, would need:
  - Class definitions with field descriptors
  - Platform-specific header sizes
  - Alignment calculations

### Logging

The function uses the `log` crate for observability:

- `debug!`: File size, scan start/end
- `info!`: Summary statistics
- `trace!`: Individual record details (if enabled)

Enable logging with:

```rust
env_logger::Builder::from_default_env()
    .filter_level(log::LevelFilter::Debug)
    .init();
```

## Testing

Run the example:

```bash
cargo run --example scan_example -- path/to/heap.hprof
```

Or use in your code:

```rust
use hprof_analyzer::{scan_records, HprofLoader};

let loader = HprofLoader::new(path);
let mmap = loader.map_file()?;
let stats = scan_records(&mmap[..])?;
stats.print();
```
