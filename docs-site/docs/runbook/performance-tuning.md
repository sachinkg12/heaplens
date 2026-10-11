---
sidebar_position: 3
title: Large dumps and analyzer memory
---

There is **no universal file-size-to-RAM multiplier** or maximum-file-size guarantee. Object/edge density, class/layout metadata, representation, temporary arrays, mapped pages, concurrent dumps, and available memory all matter.

A 25 GB capture is not guaranteed to fit a 64 GB machine. LIMIT, --rows, and collapsed tabs bound output/rendering, not the initial graph/dominator memory budget. Persistent disk-backed analysis is planned, not currently a promised low-memory mode.

## Before analysis

Use local SSD storage, completed immutable captures, adequate free RAM/disk/swap, and a matching native target. Close unused dump tabs because each can own a resident graph. Begin with a smaller representative capture to observe memory/shape; extrapolation remains approximate.

Memory mapping avoids an eager buffer copy but still faults pages into RAM. Warm page caches can change repeat timings. Compression such as xz is not a random-access replacement for graph indexes; it needs a decompression/access design, not a filename extension swap.

## Observe one process

Use the PID displayed/logged for the selected dump, not a broad pgrep/pkill of all servers.

```bash
top -pid 12345
```

On Linux use `top -p 12345`; on Windows inspect that PID in Task Manager. Replace the number with the actual process. CPU/RSS patterns vary by backend/phase and do not prove completion.

## Slow versus dead

Continue Waiting if the process is working and resources permit; Cancel if needed. Retry replaces an exited server, not the operating system's memory capacity. SIGKILL/137 alone does not prove OOM; correlate OS evidence. Avoid repeated retries under unchanged severe memory pressure.

## Measurements

[Previously recorded figures](./recorded-measurements.md) retain the original numbers and identify unresolved provenance. They are not fresh benchmarks, universal RAM ratios, or a latency SLA. A useful new benchmark records source/version/backend, JVM layout, fixture hash/shape, hardware/RAM/storage, cold/warm cache, phases, peak RSS, failures, and repeated trials.

See [Rust architecture](../architecture/rust-backend.md) and [recovery](./troubleshooting.md).
