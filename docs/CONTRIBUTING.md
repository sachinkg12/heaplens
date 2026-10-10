# Contributing to HeapLens

Thanks for your interest in contributing to HeapLens! This guide covers how to set up the project, make changes, and submit pull requests.

## Prerequisites

- **Node.js** 18+
- **Rust** (stable toolchain via [rustup](https://rustup.rs))
- **VS Code** 1.109.0+

## Setup

```bash
git clone https://github.com/sachinkg12/heaplens.git
cd heaplens

# Build the Rust server
cd hprof-analyzer && cargo build --release && cd ..

# Install Node dependencies and compile TypeScript
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

## Project Structure

```
heaplens/
  src/                  # TypeScript extension source
    extension.ts        # Activation, commands
    hprofEditorProvider.ts  # Custom editor for .hprof files
    rustClient.ts       # JSON-RPC client (stdin/stdout)
    messageHandlers.ts  # Webview message handler registry
    webview/            # Webview UI (tabs, charts, D3.js)
  hprof-analyzer/       # Rust backend
    src/main.rs         # JSON-RPC server
    src/lib.rs          # HPROF parser, dominator tree, HeapQL engine
  media/                # Icons, screenshots
  scripts/              # Build/packaging scripts
```

## Build Commands

```bash
# Rust
cd hprof-analyzer && cargo build --release
cd hprof-analyzer && cargo test --release --lib

# TypeScript
npm run compile     # Build once
npm run watch       # Rebuild on change
npm run lint        # ESLint
npm test            # Run extension tests
```

## Making Changes

1. **Create a branch** from `main`
2. **Build and test** — `cargo test --release --lib` and `npm run lint`
3. **Test manually** — press F5 in VS Code, open a `.hprof` file, verify your changes
4. **Commit** with a clear message describing the "why"

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include a brief description of what changed and why
- Add screenshots for UI changes
- Ensure `npm run lint` and `cargo test --release --lib` pass

## Code Style

- **TypeScript**: follow existing ESLint config (`.eslintrc.json`)
- **Rust**: `cargo fmt` and `cargo clippy`
- Prefer editing existing files over creating new ones
- Keep webview message handlers in the registry pattern (`messageHandlers.ts`)

## Architecture Notes

- The extension spawns `hprof-server` as a subprocess and communicates via JSON-RPC 2.0 over stdin/stdout
- The webview uses vanilla TypeScript (no React) with D3.js for charts
- New webview tabs go in `src/webview/js/` and are registered in `src/webview/js/registry.ts`
- New message handlers go in `src/messageHandlers.ts` as entries in `allHandlers`

## Reporting Issues

Use the [issue tracker](https://github.com/sachinkg12/heaplens/issues) with the provided templates for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
