---
sidebar_position: 1
title: Install HeapLens
---

## VS Code and compatible editors

Install **HeapLens** by Sachin Gupta from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=guptasachinn.heaplens) or [Open VSX](https://open-vsx.org/extension/guptasachinn/heaplens). Confirm the identifier `guptasachinn.heaplens`.

1. Open Extensions, find HeapLens, and install it.
2. Open a completed local `.hprof` file. If another editor handles it, use **Reopen Editor With → HeapLens**.
3. Start with [Overview](../tabs-guide/overview-tab.md) and the [quick start](./quick-start.md).

The package includes a native analysis server. An existing dump needs no Rust, Node.js, source checkout, or running JVM. Capture and Monitor have separate JVM requirements.

The manifest declares VS Code `^1.74.0`; chat features additionally require the relevant host APIs. Compatible editor branding does not establish participant compatibility.

## Native packages

The [v1.0.33 release](https://github.com/sachinkg12/heaplens/releases/tag/v1.0.33) contains four targets, checked October 11, 2026:

| Machine | VSIX target |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel | `darwin-x64` |
| Windows x64 | `win32-x64` |
| Linux x64 | `linux-x64` |

For manual installation, download the matching VSIX and use **Extensions: Install from VSIX**. Other architectures are not covered by these packages. Artifact availability does not prove every feature was manually tested on each OS. Remote editors need the binary for the **extension-host machine**, not necessarily your laptop.

## Other hosts and privacy

IntelliJ and standalone adapters are implemented, with current Apple Silicon release candidates. A merge does not publish a Marketplace plugin, npm package, or Homebrew tap. Use [choose your host](./choose-host.md), [IntelliJ setup](./intellij.md), or [standalone setup](./standalone.md); do not guess public install commands.

Analysis is local. AI is optional and has a separate [sharing boundary](../ai-integration/privacy.md). [Telemetry](../runbook/telemetry.md) is independent: VS Code/standalone default to usage/errors subject to controls; IntelliJ requires approval. Turn it off before opening a dump if you want it off from the first operation.

[Contributor setup](../architecture/contributing.md) is separate from ordinary installation. See [troubleshooting](../runbook/troubleshooting.md) for missing binaries and recovery.
