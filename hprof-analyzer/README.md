# HeapLens analysis engine

The shared Rust library and native entry points for JVM heap analysis. `hprof-server` serves the IDE and MCP transports; `heaplens` provides terminal commands and the local browser launcher.

- [Rust engine guide](../docs-site/docs/architecture/rust-backend.md).
- [Build and contribute](../docs-site/docs/architecture/contributing.md).
- [CLI command reference](../docs-site/docs/api-reference/cli.md).

Keep heap captures complete and immutable while analyzing them. Memory mapping does not impose a total analysis-memory limit.

See the repository [license](../LICENSE) and packaged third-party notices.
