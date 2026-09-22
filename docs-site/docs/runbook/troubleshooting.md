---
sidebar_position: 1
title: Troubleshooting
---

# Troubleshooting

Common issues and their solutions when using HeapLens.

## Extension Issues

### "Rust server binary not found"

The extension cannot find the `hprof-server` binary.

**Solution:**
1. Verify the binary exists:
   ```bash
   ls hprof-analyzer/target/release/hprof-server
   ```
2. If not, build it:
   ```bash
   cd hprof-analyzer && cargo build --release
   ```
3. Check file permissions:
   ```bash
   chmod +x hprof-analyzer/target/release/hprof-server
   ```

### Analysis never completes (stuck at "Analyzing...")

The Rust backend may have crashed or hung.

**Diagnosis:**
1. Check the Output channel: **View → Output → HeapLens**
2. Look for progress messages or error traces
3. Check if the `hprof-server` process is still running:
   ```bash
   ps aux | grep hprof-server
   ```

**Common causes:**
- **Corrupted HPROF file** — Incomplete dump (e.g., process was killed during jmap). Try re-capturing.
- **Out of memory** — The server needs ~3-4x the file size in RAM. Check `Activity Monitor` / `htop`.
- **Very large file** — Files over 1 GB can take several minutes. Wait longer.

### Webview is blank or shows only the tab bar

The webview loaded but data was not received.

**Solution:**
1. Close and reopen the `.hprof` file
2. If persistent, open Developer Tools (see [Debugging Webview](./debugging-webview)) and check the Console tab for errors
3. Ensure `npm run compile` was run after any TypeScript changes

### AI Chat says "No API key configured"

**Solution:**
1. Open VS Code Settings (`Cmd+,` on macOS or `Ctrl+,` on Windows/Linux)
2. Search for `heaplens.llm` and select your provider
3. Run **HeapLens: Set or Replace LLM API Key** from the Command Palette
4. Enter the provider key in the masked prompt; use the eye button only to inspect the value while typing
5. Run **HeapLens: Show LLM API Key Status** to confirm the saved key by its masked suffix

Saved keys cannot be revealed in full. VS Code, Cursor, and other compatible editors keep separate SecretStorage databases, so configure the key again in each editor and profile.

## Build Issues

### Rust: `cargo build` fails with "linking" errors

**macOS:** Ensure Xcode command line tools are installed:
```bash
xcode-select --install
```

**Linux:** Install build essentials:
```bash
sudo apt install build-essential
```

### Rust: `cargo test` killed by SIGKILL

On macOS, debug-mode tests can consume excessive memory and trigger the OOM killer.

**Solution:** Always run tests in release mode:
```bash
cargo test --release --lib
```

### TypeScript: `npm run compile` shows type errors

Ensure dependencies are installed:
```bash
npm install
```

If errors persist, try cleaning:
```bash
rm -rf out/ node_modules/
npm install
npm run compile
```

## Analysis Accuracy Issues

### Retained sizes don't match Eclipse MAT

Small differences (5-10%) between HeapLens and Eclipse MAT are expected due to:
- Different handling of unreachable objects
- Slight differences in edge extraction for complex inheritance chains
- HeapLens uses `reachable_heap_size` as the denominator for percentages (matching MAT)

If differences are larger, check:
- Is the HPROF file the same? (MAT sometimes re-parses)
- Is the file complete? (truncated files produce different results)

### No leak suspects detected

Leak suspects require at least one object or class retaining >5% of the reachable heap. If memory is evenly distributed, no suspects will be flagged.

**What to try:**
- Check the Histogram tab for classes with unusually high instance counts
- Look at the Dominator Tree top entries manually
- Use the AI Chat to ask about memory patterns

### Waste analysis shows 0% waste

This can happen if:
- The heap has very few `java.lang.String` instances (e.g., a non-Java-standard JVM)
- All strings are unique (no duplicates)
- No empty `HashMap`, `ArrayList`, or `LinkedHashMap` instances

## Performance Issues

### Analysis takes too long

| File Size | Expected Time | If Slower |
|-----------|--------------|-----------|
| &lt; 50 MB | &lt; 5s | Check if other processes are consuming CPU |
| 50-200 MB | 5-15s | Normal |
| 200 MB - 1 GB | 15-60s | Normal; consider more RAM |
| > 1 GB | 1-5 min | Close other applications to free RAM |

**Optimization tips:**
- Close unnecessary applications to free RAM (the server needs ~3-4x file size)
- Use an SSD — memory-mapped I/O is faster with SSD page cache
- The first analysis of a file is slower; the OS caches pages for subsequent runs

### Extension Development Host is slow

When developing:
- Use `npm run watch` instead of `npm run compile` for incremental builds
- Disable other extensions in the Development Host to isolate performance
