---
sidebar_position: 0
title: Choose your host
---

HeapLens shares analysis, not every host responsibility. Installation, credentials, source lookup, approval, exports, and process lifecycle have separate adapters.

## Availability

Checked **October 11, 2026** against source and public release assets; this is not platform certification.

| Host | Distribution | Current scope |
| --- | --- | --- |
| VS Code / compatible editors | Public Marketplace, Open VSX, four v1.0.33 VSIX targets | macOS ARM64/x64, Windows x64, Linux x64 packages |
| IntelliJ | Implemented, install-from-disk candidate; no public listing promised here | Current candidate: macOS Apple Silicon; check candidate IDE build range |
| Terminal/browser | Implemented portable/npm/Homebrew candidate packaging | Current candidate: macOS Apple Silicon; packaged npm/browser needs native ARM64 Node 22+ |
| MCP clients | Trusted native `hprof-server --mcp` plus client configuration | Depends on server target and client validation |

A source merge does not publish a package. npm is cross-platform but an ARM64-only native payload is not. Verify [release assets](https://github.com/sachinkg12/heaplens/releases).

## What stays shared?

| Responsibility | Boundary |
| --- | --- |
| Parsing, references, dominators, histogram, suspects, waste, HeapQL | Shared Rust engine; compare the same version/backend/options |
| Eleven views | Common analysis views; source, AI, exports and other controls differ by host |
| Source | VS Code workspace/dependency resolution; IntelliJ project/attached sources/decompiler; browser explicit roots |
| Fix with AI | Independent project-source resolution, full-file approval, proposal review; apply/Undo differs by host |
| Credentials, model calls, history | Host-specific storage and lifetime |
| Monitor | Separate compatible JVM agent and authorized connection |
| Exports/clipboard | Native save/clipboard or browser download |
| Telemetry | Host-specific permission and preference adapters |

Continue with [extension installation](./installation.md), [IntelliJ](./intellij.md), [standalone](./standalone.md), [MCP](../mcp/setup.md), or [AI privacy](../ai-integration/privacy.md). Known denominator/context limitations are disclosed beside affected guides.
