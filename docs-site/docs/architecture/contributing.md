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

IntelliJ requires the project's Gradle/JDK configuration. Run tasks from intellij-plugin and check the candidate staging/verifier guides before installing a ZIP. Browser source development uses `node browser-ui/build.cjs` from the root, then a compatible native CLI/server and built host path. Packaged candidates are easier to test than a binary without browser assets.

These commands are source-development steps, not universal installation prerequisites.

## Documentation

From docs-site:

```bash
npm ci
npm run check:contracts
npm run typecheck
npm run build
npm run serve
```

The main-branch Pages workflow builds and deploys an artifact; do not run a guessed yarn/gh-pages deployment command. PR checks are read-only and do not publish.

Keep technical claims close to their limits. Update capability/contracts when code changes. Use coherent illustrative arithmetic or versioned measured evidence; do not modify historical benchmark numbers to make a claim look consistent. No public report should contain raw dumps, credentials, private paths, or full source.

See [support](../runbook/support.md) for reporting and [architecture](./system-overview.md) for the shared/host boundary.
