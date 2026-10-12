---
title: Build and contribute
---

Ordinary users should [install a package](../getting-started/installation.md). Contributors need a reviewed checkout, Rust/Cargo, a supported Node runtime (22 or 24 recommended for this site's checks), and the relevant host toolchain.

## Extension and native binaries

From the repository root:

```bash
npm ci
npm run compile
npm test
cargo build --locked --release --manifest-path hprof-analyzer/Cargo.toml
```

Use the repository's development-launch configuration and native-server staging scripts. Avoid copying an old binary into a new host candidate without checking source revision/target.

## IntelliJ and browser

IntelliJ requires JDK 21 and the project's Gradle wrapper. Build the shared server and fetch its locked dependency graph before packaging, because the notices task reads metadata offline:

```bash
cargo build --locked --release --manifest-path hprof-analyzer/Cargo.toml --bin hprof-server
cargo fetch --locked --target aarch64-apple-darwin --manifest-path hprof-analyzer/Cargo.toml
./intellij-plugin/gradlew -p intellij-plugin buildPlugin
```

The current plugin package targets macOS Apple Silicon. Browser source development uses the root npm dependencies, built browser assets and both native executables:

```bash
node browser-ui/build.cjs
cargo build --locked --release --manifest-path hprof-analyzer/Cargo.toml --bin heaplens --bin hprof-server
./hprof-analyzer/target/release/heaplens open "/absolute/path/app.hprof" --telemetry off
```

These commands are source-development steps, not universal installation prerequisites.

## Documentation

Website prerequisites, local preview, build checks and deployment are described in [documentation site development](./documentation-site.md).

Keep technical claims close to their limits. Update capability/contracts when code changes. Use coherent illustrative arithmetic or versioned measured evidence; do not modify historical benchmark numbers to make a claim look consistent. No public report should contain raw dumps, credentials, private paths, or full source.

See [support](../runbook/support.md) for reporting and [architecture](./system-overview.md) for the shared/host boundary.
