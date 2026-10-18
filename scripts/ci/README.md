# Host boundaries and release routing

Historical remote workflow result, October 11, 2026: [CI/CD run 38182258035](https://github.com/sachinkg12/heaplens/actions/runs/38182258035) at commit `ea56dd6` completed successfully, including extension validation, boundary tests, Rust tests, IntelliJ candidate checks and all four VSIX builds. Automatic versioning and publication were skipped on that run; it predates the coordinated release train described below. Successful validation is not a new release or Marketplace approval.

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

| Changed paths or event | IntelliJ checks | Rust unit/integration checks | VSIX build | Publication |
|---|---|---|---|---|
| intellij-plugin only, including its build/docs | Yes | No; shared server still built for IntelliJ process tests | No | No |
| VS Code host src outside src/webview, compiler config or VSIX packaging | No | No on this branch/PR run | Yes | No |
| src/webview, D3 or root npm manifests | Yes | No on this branch/PR run | Yes | No |
| Shared Rust or server binaries | Yes | Yes | Yes | No |
| CI/workflow policy | Yes | Yes | Yes | No |
| Documentation-only outside intellij-plugin / CI directories | No | No | No | No |
| Unknown paths | Yes | Yes | Yes | No; explicit release decision needed |
| Stable vMAJOR.MINOR.PATCH tag | Yes | Yes | Yes | VS Code after passing checks |
| Exact intellij-vMAJOR.MINOR.PATCH tag | Yes | Yes | No | No; the tested IntelliJ ZIP is published after passing checks |
| Other intellij-v... tags (prerelease or malformed) | Yes | Yes | No | No; validation only |
| cli-v... tag | No | Yes | No | No; CLI publication runs in the standalone workflow with its own gates |

Selection is cumulative across the complete Git diff, not just the last commit or a limited API file list. PRs use the merge base. Deletions and both sides of renames count. Missing history or invalid routing inputs fail the workflow rather than authorize a release.

The existing stable v1.0.x format is retained. Other v-prefixed tags, including prerelease tags, validate but do not publish. IntelliJ and CLI releases use their own tag namespaces and version numbers, described below; nothing tags them automatically.

## Tagged IntelliJ and CLI releases

Pull requests and pushes to main only build and test candidates. A deliberate exact release tag on a commit that is already on main starts the corresponding build, test and publication workflow. The publish job downloads the exact artifact from that tag run; it does not publish the earlier PR artifact or rebuild during publication. Prepare versions and notes together using the local commands below.

**IntelliJ, tag `intellij-vMAJOR.MINOR.PATCH`.** Set `version` in `intellij-plugin/build.gradle.kts` first; the tag must equal it. The run executes the boundary, Rust and IntelliJ jobs. `test-intellij` writes `SHA256SUMS` next to the ZIP it tested and uploads both. `publish-intellij` then runs on `ubuntu-latest` with `contents: write` only, downloads that artifact, and `scripts/ci/release-intellij.cjs` checks the tag syntax, the ancestry of the tagged commit on `origin/main`, the Gradle version, the ZIP name, the embedded plugin descriptor version and the checksums. It creates the GitHub release `intellij-v...` with the ZIP and `SHA256SUMS`, uploads the identical ZIP to JetBrains Marketplace through the documented upload API with `JETBRAINS_MARKETPLACE_TOKEN`, and attaches `marketplace-receipt.json` to the release. Marketplace verifies and lists the update itself; a green job is an accepted upload, not an approved listing. No Gradle task runs in the publish job, so nothing can be rebuilt or repackaged.

**CLI, tag `cli-vMAJOR.MINOR.PATCH`.** See [the standalone packaging guide](../distribution/README.md#publish-after-acceptance) for the version coupling and the publication order.

**Reruns.** GitHub release assets, npm versions and tap formulas are checked before writing. Matching content is skipped; conflicting content stops the job. VS Code candidates carry per-platform source/version/checksum records. Both extension registries are checked separately, including a SHA-256 of each downloaded package. Only missing targets are uploaded. A lost upload response is resolved by verifying registry state, not by blindly uploading again. A delayed or unverifiable upload fails closed; rerun the failed publish job after it becomes visible. IntelliJ recognizes previous uploads through its matching receipt; an existing version without that receipt stops for manual reconciliation. Rerun failed publication jobs with their original artifacts, not all build jobs. Rebuilding can change archive bytes and correctly trigger a conflict. If Actions artifacts expire, the original checksummed GitHub release assets must be recovered and verified before an operator retries; do not substitute a rebuild.

VS Code/Open VSX visibility checks allow approximately 15 minutes per pending platform, with a 20-second polling interval. Set `HEAPLENS_RELEASE_VERIFY_SECONDS` to an integer from 1 to 3600 to override that nominal window; CI reads the repository variable with the same name. Request durations add to the polling time. A confirmed byte conflict stops immediately instead of waiting through that window. Marketplace delays can exceed the window, so a failed verification still requires a safe rerun with the original package. The direct tooling pins in `vscode-tools.cjs` are `@vscode/vsce@3.6.2` for both packaging and publication and `ovsx@1.3.0` for Open VSX publication. VSCE retains the Node 20 packaging-runner requirement; Open VSX publication runs on Node 22. Pins are deliberate source changes, not floating `npx` selections.

**Secrets.** `JETBRAINS_MARKETPLACE_TOKEN` is read only by `publish-intellij`. `HOMEBREW_TAP_TOKEN`, a fine-grained token limited to the tap repository's contents, is read only by `publish-cli`. npm uses trusted publishing with the job's short-lived identity token. `VSCE_PAT` and `OVSX_PAT` belong only to VS Code publication. The retired auto-version job no longer needs `PAT_TOKEN`. These edits do not delete or revoke any existing secret.

## Coordinated release preparation

From a clean tracked checkout on a release branch, run:

~~~bash
node scripts/ci/prepare-release.cjs --preview
node scripts/ci/prepare-release.cjs
node scripts/ci/validate-release.cjs
~~~

Preparation defaults to patch bumps for all three hosts. Override with `--vscode X.Y.Z`, `--intellij X.Y.Z` and `--cli X.Y.Z`. It checks fresh remote tags with `git ls-remote`, not a potentially stale local tag list; this requires read access to origin. The changelog date defaults to the operator's local calendar day; use `--date YYYY-MM-DD` for an explicit reproducible date. The date is stored in the plan, so CI does not recalculate it in another time zone. The command updates both npm manifests, the Gradle version, CLI configuration, Cargo manifest/lockfile, plugin change notes, the changelog and `scripts/ci/release-plan.json`. It never creates a commit, tag, PR or remote write. `--preview` calculates the same result without editing files. Unrelated files are preserved; existing untracked release targets are not overwritten.

Baselines come from `release-record.json` attached only after a host's publication completes. IntelliJ records an accepted submission separately from public listing: preparation also requires that exact update ID to be approved, listed, visible and on Stable before using it as a baseline. Pending or failed releases and bare version tags are not assumed to have shipped. For historical manual packages without a record, confirm the actual source once and supply `--baseline-HOST FULL_COMMIT_SHA --baseline-HOST-evidence "Verified package/source evidence"` for each missing host. Do not substitute an inferred version-setting commit. Manual overrides and their evidence are preserved in the plan. The CLI bootstrap needs this explicit source too if it predates publication records.

For the first train, all three historical packages lack these new records. Replace every source/evidence placeholder below before running the preview:

~~~bash
node scripts/ci/prepare-release.cjs \
  --vscode 1.0.35 --intellij 0.1.17 --cli 0.1.1 \
  --baseline-vscode VERIFIED_FULL_VSCODE_1_0_34_SHA \
  --baseline-vscode-evidence "REPLACE_WITH_VSCODE_ARTIFACT_AND_SOURCE_EVIDENCE" \
  --baseline-intellij VERIFIED_FULL_INTELLIJ_0_1_16_SHA \
  --baseline-intellij-evidence "REPLACE_WITH_INTELLIJ_ARTIFACT_AND_SOURCE_EVIDENCE" \
  --baseline-cli FULL_SHA_USED_FOR_MANUAL_NPM_0_1_0_PUBLICATION \
  --baseline-cli-evidence "REPLACE_WITH_NPM_ARCHIVE_CHECKSUM_AND_SOURCE_EVIDENCE" \
  --preview
~~~

Inspect the preview, then repeat the same command without `--preview` to write the prepared diff. The CLI baseline must be the source commit used to build the archive actually published manually as 0.1.0. Do not assume PR 9 is that source merely because it introduced CLI packaging. If the bootstrap includes later engine improvements, those improvements are already in the CLI baseline and must not be advertised as newly added in 0.1.1. Each historical baseline reads only its own host's version file; an unrelated prototype IDE version at the CLI baseline does not prevent preparation.

Notes use first-parent history, PR titles/numbers and direct-commit subjects with source links. Runtime path routing is distinct from CI check routing. CI/publishing plumbing, tests, traffic and documentation-only changes are excluded; shared-engine changes appear in all affected host sections. Empty sections state that the release is coordinated maintenance, without inventing features. Generic titles receive `REVIEW:` and must be corrected once in the plan; run `node scripts/ci/prepare-release.cjs --refresh-notes` to regenerate the changelog and plugin HTML without changing versions. Titles are escaped for Markdown and HTML. Notes are concise change summaries, not exhaustive descriptions of every change inside a large PR.

Review and commit the prepared diff, open a release PR, and merge after validation. Ordinary unchanged versions remain valid on later PRs; strict release checks do not demand another bump after each merge. Changes to product code after preparation invalidate that candidate's release notes and require regeneration before release.

After the merged main push run finishes successfully, use its full SHA:

~~~bash
node scripts/ci/tag-release.cjs --sha FULL_MERGED_COMMIT_SHA
node scripts/ci/tag-release.cjs --sha FULL_MERGED_COMMIT_SHA --execute
~~~

The first command fetches main's objects without importing tags or moving the local branch, then performs preflight checks with no remote writes. The tested release SHA may be the fetched main tip or an ancestor followed only by allowlisted traffic/research/documentation paths; this permits the daily `[skip ci]` traffic snapshot without inventing a CI run for that snapshot. Product code, version manifests, build scripts, workflows and unknown paths in the intervening diff block tagging. The output reports the fetched main SHA and intervening paths. CI must still be successful for the exact release SHA, never the untested tip. Only explicit `--execute` pushes all three lightweight tag references atomically at that release SHA, without changing local tags. It also checks origin/repository identity, prepared metadata, exact-SHA main push workflow, successful aggregate `checks`, and fresh remote tags. PR runs, failed runs, existing tags and version regressions are rejected. No publishing token or extra CI token is needed by this local command beyond the operator's existing GitHub read and Git push credentials.

Atomic tag creation is not an atomic multi-registry transaction. Each host builds/tests/publishes independently from that revision. A partial release remains possible and is recovered per failed publish job; public availability also depends on marketplace processing. Publication records identify completed deliveries, not independent user acceptance or an approved IntelliJ listing by themselves.

## Release safety and remaining repository settings

The checks job is a stable aggregate gate. A selected job that fails, is cancelled or is unexpectedly skipped blocks it. Deliberately unselected host jobs may be skipped. Versioning, VSIX packaging and publication depend on this gate.

There is no per-merge automatic versioning or publication. Exact host-prefixed tags remain the sole publication signal. Preparation and tagging are separate deliberate operations; neither commit-message conventions nor missing version tags imply release authority.

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
