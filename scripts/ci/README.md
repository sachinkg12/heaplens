# Host boundaries and release routing

Current workflow checked October 11, 2026. [CI/CD run 38182258035](https://github.com/sachinkg12/heaplens/actions/runs/38182258035) at commit `ea56dd6` completed successfully, including extension validation, boundary tests, Rust tests, IntelliJ candidate checks and all four VSIX builds. Automatic versioning and publication were skipped on that run; successful validation is not a new release or Marketplace approval.

The IntelliJ candidate is **macOS Apple Silicon only**, with IntelliJ 2026.1–2026.2 metadata. `test-intellij` uses `macos-14`, rejects a non-ARM64 runner, builds the checkout's server and plugin ZIP, extracts that exact ZIP, runs required process/recovery tests and API verification, then uploads the candidate and reports. It makes no JetBrains upload, tag or Git push. The remote job passed in the run above; it does not establish native GUI acceptance or other-platform compatibility.

API verification uses JetBrains' documented `-ignore-os-arch` mode for virtual platform constraints only; genuine missing dependencies, invalid plugins and incompatible/internal/invalid-extension APIs remain blocking. OS/architecture descriptor tests, binary-byte checks and the native runner/package smoke enforce the Mac scope separately. A successful API verdict is not an installed native UI, delivery or privacy-compliance pass. Other IntelliJ platforms are deferred; the existing VS Code four-platform packaging matrix is unchanged.

## Ownership

- Rust under hprof-analyzer is shared. Both hosts use the same JSON-line server protocol, with separate processes per editor.
- Production TypeScript under src is the VS Code host plus the existing shared webview sources.
- IntelliJ host APIs, lifecycle additions and Gradle artifacts stay under intellij-plugin. Its build reads the reused webview modules and adds its own bridge; it does not rewrite the original sources.
- tsconfig.json explicitly includes src/**/*.ts and excludes intellij-plugin. The VSIX excludes the entire IntelliJ directory and scripts directory.
- These are code/build/package boundaries, not a security sandbox between arbitrary future changes. Shared renderer/DOM contracts and the unversioned server protocol still need compatibility testing.

## What selects checks and releases

Boundary tests and VS Code npm test run on every CI event. The table shows additional selection and VS Code packaging/release eligibility.

| Changed paths or event | IntelliJ checks | Rust unit/integration checks | VSIX build | Automatic VS Code version bump |
|---|---|---|---|---|
| intellij-plugin only, including its build/docs | Yes | No; shared server still built for IntelliJ process tests | No | No |
| VS Code host src outside src/webview, compiler config or VSIX packaging | No | No on this branch/PR run | Yes | On main after checks |
| src/webview, D3 or root npm manifests | Yes | No on this branch/PR run | Yes | On main after checks |
| Shared Rust or server binaries | Yes | Yes | Yes | On main after checks |
| CI/workflow policy | Yes | Yes | Yes | No, unless combined with release-relevant files |
| Documentation-only outside intellij-plugin / CI directories | No | No | No | No |
| Unknown paths | Yes | Yes | Yes | No; explicit release decision needed |
| Stable vMAJOR.MINOR.PATCH tag | Yes | Yes | Yes, then VS Code publication after passing checks | No recursive bump |
| Exact intellij-vMAJOR.MINOR.PATCH tag | Yes | Yes | No | No; the tested IntelliJ ZIP is published after passing checks |
| Other intellij-v... tags (prerelease or malformed) | Yes | Yes | No | No; validation only |
| cli-v... tag | No | Yes | No | No; CLI publication runs in the standalone workflow with its own gates |

Selection is cumulative across the complete Git diff, not just the last commit or a limited API file list. PRs use the merge base. Deletions and both sides of renames count. Missing history or invalid routing inputs fail the workflow rather than authorize a release.

The existing stable v1.0.x format is retained. Other v-prefixed tags, including prerelease tags, validate but do not publish. IntelliJ and CLI releases use their own tag namespaces and version numbers, described below; nothing tags them automatically.

## Tagged IntelliJ and CLI releases

Pull requests and pushes to main only build and test candidates. A deliberate exact release tag on a commit that is already on main turns the candidate that CI tested into a published package. Version bumps and changelog entries stay manual.

**IntelliJ, tag `intellij-vMAJOR.MINOR.PATCH`.** Set `version` in `intellij-plugin/build.gradle.kts` first; the tag must equal it. The run executes the boundary, Rust and IntelliJ jobs. `test-intellij` writes `SHA256SUMS` next to the ZIP it tested and uploads both. `publish-intellij` then runs on `ubuntu-latest` with `contents: write` only, downloads that artifact, and `scripts/ci/release-intellij.cjs` checks the tag syntax, the ancestry of the tagged commit on `origin/main`, the Gradle version, the ZIP name, the embedded plugin descriptor version and the checksums. It creates the GitHub release `intellij-v...` with the ZIP and `SHA256SUMS`, uploads the identical ZIP to JetBrains Marketplace through the documented upload API with `JETBRAINS_MARKETPLACE_TOKEN`, and attaches `marketplace-receipt.json` to the release. Marketplace verifies and lists the update itself; a green job is an accepted upload, not an approved listing. No Gradle task runs in the publish job, so nothing can be rebuilt or repackaged.

**CLI, tag `cli-vMAJOR.MINOR.PATCH`.** See [the standalone packaging guide](../distribution/README.md#publish-after-acceptance) for the version coupling and the publication order.

**Reruns.** Every publication step checks before it acts. A GitHub release asset, npm version or tap formula that already exists with identical content is skipped; one with different content stops the job for a person to resolve. Marketplace re-packages uploads, so an IntelliJ rerun recognizes a previous upload only through the receipt on the GitHub release; a listed version without a matching receipt stops the job.

**Secrets.** `JETBRAINS_MARKETPLACE_TOKEN` is read only by `publish-intellij`. `HOMEBREW_TAP_TOKEN`, a fine-grained token limited to the tap repository's contents, is read only by `publish-cli`. npm uses trusted publishing with the job's short-lived identity token, so no npm secret exists. The VS Code tokens and `PAT_TOKEN` are not available to either release job.

The first boundary-infrastructure commit also changes package.json/package-lock.json and tsconfig.json. It is therefore not an IntelliJ-only commit and can still legitimately trigger a VS Code patch release when merged to main. The no-release guarantee applies to commits whose entire relevant diff is IntelliJ-only.

## Release safety and remaining repository settings

The checks job is a stable aggregate gate. A selected job that fails, is cancelled or is unexpectedly skipped blocks it. Deliberately unselected host jobs may be skipped. Versioning, VSIX packaging and publication depend on this gate.

Auto-version keeps the existing PAT_TOKEN mechanism, because pushes using the repository GITHUB_TOKEN do not normally trigger another workflow run. It operates only on the validated commit. If main has advanced, it fails visibly; do not force a tag or assume a later IntelliJ-only push will release the pending VS Code change. Revalidate current main and make an explicit release decision. The branch and version tag are pushed atomically without force.

Stable release tags deliberately rerun both host suites even if the original change was VS Code-only. This conservative final compatibility gate may expose prototype failures that must be fixed before publication.

Branch protection is not configured by these file edits. After the first successful PR run, a repository administrator should make the aggregate checks job required and review old required checks that can now be intentionally skipped. No repository settings, secrets or remote branches were changed here.

## Reproducible checks

From the repository root:

~~~bash
npm ci
npm run test:boundaries
npm test
cargo test --release --lib --bins --test integration --test shallow_size --test cli --manifest-path hprof-analyzer/Cargo.toml
~~~

The boundary suite parses the real workflow, checks dependencies and compiler scope, and tests the routing policy with temporary local Git histories. It never tags, pushes or versions the working repository.

The current IntelliJ CI job uses Java 21, the pinned Gradle wrapper and IntelliJ IDEA 2026.1 SDK. It builds hprof-server from the checkout and generates a small HPROF from the public ClassRetainedCounterexample.java source. No private HPROF or hard-coded developer home directory is required.

The notices task runs `cargo metadata --offline --locked`. A release build alone does not populate its complete locked dependency graph, including development dependencies. Fetch that graph before Gradle packaging, as both the IntelliJ and standalone workflows now do:

~~~bash
cargo build --locked --release --manifest-path hprof-analyzer/Cargo.toml --bin hprof-server
cargo fetch --locked --target aarch64-apple-darwin --manifest-path hprof-analyzer/Cargo.toml
~~~

Run the package build and extracted-package tests on an Apple Silicon host. With `heaplens.test.ci=true`, explicit fixture/server/package inputs are mandatory; real-engine checks must not silently skip. The test executable comes from the extracted candidate, not an unrelated developer override. Current counts belong to the reports from each identified run, not to a fixed number in this guide.

Address-specific and layout-matrix checks carry the `local-fixture` tag and are intentionally excluded from CI mode. The CI profile uses its generated public fixture instead. Neither mode is a substitute for native IntelliJ UI testing or the full performance corpus.

The IntelliJ job uploads the candidate ZIP and test/verifier reports, not heap dumps. The remote Apple Silicon package/process/API run is distinct from native GUI testing. IntelliJ Windows/Linux packages and Marketplace publication are not established by it.

## Historical evidence from September 29

The following results describe the original local boundary increment, not the current suite counts or current package. Preserve them as dated evidence rather than interpreting them as pending remote work.

- Five boundary regressions failed on the prior workflow/compiler configuration; all 27 boundary tests now pass.
- VS Code: 66 tests passed; compile passed; zero lint errors and seven existing warnings.
- Rust: 164 library, one binary cancellation-correlation, 41 integration and seven shallow-size tests passed (213 total). Existing compiler warnings remain.
- IntelliJ CI-mode rehearsal on macOS: 23 Java plus nine webview tests passed using a freshly generated fixture. Full local matrix: 30 Java plus nine webview tests passed.
- Gradle wrapper first download and checksum verification completed, followed by the full local test run.
- actionlint 1.7.7 validated ci.yml with no diagnostics. ShellCheck/Pyflakes were not installed or run.
- VSIX file-list check: 152 entries, with no IntelliJ or CI script files. No VSIX was built or published.

References informing the workflow behavior:

- [GitHub job dependencies and conditional execution](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)
- [Workflow triggering and token behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [Gradle GitHub Actions integration](https://docs.gradle.org/current/userguide/github-actions.html)

These references describe platform behavior. The dated run linked above establishes the recorded remote result; it does not establish every native workflow or future run.
