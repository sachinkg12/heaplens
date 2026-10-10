# Async JSON-RPC Server

## Overview

The `hprof-server` binary provides an async JSON-RPC 2.0 server that processes CPU-intensive heap analysis tasks asynchronously using tokio blocking tasks.

## Architecture

### Concurrency Model

The server uses a **non-blocking async architecture** with the following components:

1. **Async Runtime**: Tokio runtime for handling I/O and task scheduling
2. **Blocking Tasks**: CPU-intensive work (heap analysis) runs in `tokio::task::spawn_blocking`
3. **Channels**: Results are communicated via `mpsc::UnboundedChannel`
4. **Graceful Shutdown**: Handles CTRL+C and stdin closure

### Request Flow

```
Client Request (stdin)
    ↓
Parse JSON-RPC Request
    ↓
Immediate Response: {"status": "processing", "request_id": N}
    ↓
Spawn Blocking Task (tokio::task::spawn_blocking)
    ├─→ HprofLoader::map_file()
    ├─→ build_graph()
    └─→ calculate_dominators()
    ↓
Result sent via channel
    ↓
Notification sent: {"method": "heap_analysis_complete", "params": {...}}
```

## Protocol

### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "analyze_heap",
  "params": {
    "path": "/path/to/heap.hprof"
  }
}
```

### Immediate Response

The server responds immediately with a processing status:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": "processing",
    "request_id": 1
  }
}
```

### Completion Notification

When analysis completes, a notification is sent (no `id` field):

```json
{
  "jsonrpc": "2.0",
  "method": "heap_analysis_complete",
  "params": {
    "request_id": 1,
    "status": "completed",
    "top_objects": [
      {
        "object_id": 123456,
        "node_type": "Instance",
        "shallow_size": 1024,
        "retained_size": 1048576
      },
      ...
    ]
  }
}
```

### Error Notification

If analysis fails:

```json
{
  "jsonrpc": "2.0",
  "method": "heap_analysis_complete",
  "params": {
    "request_id": 1,
    "status": "error",
    "error": "Failed to load HPROF file: ..."
  }
}
```

## Usage

### Building

```bash
cd hprof-analyzer
cargo build --release
```

### Running

```bash
# Start the server (reads from stdin, writes to stdout)
./target/release/hprof-server

# Send a request
echo '{"jsonrpc":"2.0","id":1,"method":"analyze_heap","params":{"path":"heap.hprof"}}' | ./target/release/hprof-server
```

### Example Client

```rust
use std::process::{Command, Stdio};
use std::io::{Write, BufRead, BufReader};

let mut child = Command::new("./target/release/hprof-server")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .spawn()?;

let mut stdin = child.stdin.take().unwrap();
let stdout = child.stdout.take().unwrap();
let reader = BufReader::new(stdout);

// Send request
writeln!(stdin, r#"{"jsonrpc":"2.0","id":1,"method":"analyze_heap","params":{"path":"heap.hprof"}}"#)?;

// Read immediate response
let mut line = String::new();
reader.read_line(&mut line)?;
println!("Response: {}", line);

// Read notification when complete
line.clear();
reader.read_line(&mut line)?;
println!("Notification: {}", line);
```

## Features

### Async Processing

- **Non-blocking I/O**: Stdin reading doesn't block the async runtime
- **CPU-intensive work isolation**: Heavy computation runs in blocking tasks
- **Concurrent requests**: Multiple analysis tasks can run simultaneously
- **Resource efficient**: Doesn't block async executor threads

### Error Handling

- **Graceful degradation**: Errors are returned as notifications
- **Request validation**: Invalid requests return error responses
- **Logging**: All errors are logged for debugging

### Shutdown

The server handles shutdown gracefully:

- **CTRL+C**: Sends shutdown signal
- **Stdin closure**: Detects when stdin is closed
- **Cleanup**: Waits for in-flight tasks before exiting

## Performance

### Benefits

- **Responsive**: Immediate response to requests
- **Scalable**: Can handle multiple concurrent requests
- **Efficient**: CPU work doesn't block I/O
- **Resource-aware**: Uses tokio's blocking thread pool

### Limitations

- **Memory**: Each analysis task loads the entire HPROF file into memory (via mmap)
- **CPU**: Heavy computation (graph building, dominator calculation) is CPU-bound
- **Throughput**: Limited by CPU cores and memory bandwidth

## Implementation Details

### Key Components

1. **Server struct**: Manages request IDs and result channels
2. **Blocking tasks**: `analyze_heap_blocking()` runs in `spawn_blocking`
3. **Result channel**: `mpsc::UnboundedChannel` for async result delivery
4. **Notification task**: Dedicated task for sending completion notifications

### Thread Safety

- **Atomic counters**: Request IDs use `AtomicU64`
- **Channel communication**: Thread-safe message passing
- **Stdout locking**: Serialized output to prevent interleaving

## Future Enhancements

- Request queueing with priorities
- Progress notifications during analysis
- Cancellation support (abort in-flight tasks)
- Metrics and monitoring
- Request batching
- Result caching
