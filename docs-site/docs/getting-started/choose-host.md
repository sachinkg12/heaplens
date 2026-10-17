---
sidebar_position: 0
title: Choose your host
---

HeapLens shares analysis, not every host responsibility. Installation, credentials, source lookup, approval, exports, and process lifecycle have separate adapters.

## Availability

Package versions and publication steps are separate for each host. The release workflow targets the platforms below; package availability is not certification of every feature on every OS.

| Host | Distribution | Current scope |
| --- | --- | --- |
| VS Code / compatible editors | Marketplace, Open VSX and platform-specific VSIX packages | macOS ARM64/x64, Windows x64, Linux x64 targets; 1.0.34 introduces the new analysis/storage controls |
| IntelliJ | [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/35004-heaplens) and separately versioned release ZIPs | macOS Apple Silicon, IntelliJ IDEA 2026.1–2026.2; new controls require a matching updated plugin package |
| Terminal/browser | Implemented portable/npm/Homebrew candidate packaging | Current candidate: macOS Apple Silicon; packaged npm/browser needs native ARM64 Node 22+ |
| MCP clients | Trusted native `hprof-server --mcp` plus client configuration | Depends on server target and client validation |

The VS Code main/tag workflow builds and publishes its selected targets after checks. IntelliJ CI prepares a ZIP but does not upload it to Marketplace; standalone candidate CI prepares archives/formulas but does not publish an npm package or tap. npm is cross-platform but an ARM64-only native payload is not. Verify [release assets](https://github.com/sachinkg12/heaplens/releases) and each host's listing.

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
