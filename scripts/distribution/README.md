# Standalone CLI packaging

Homebrew and npm install the same self-contained CLI and browser runtime. They do not install an IDE extension. The first candidate is macOS Apple Silicon only, with a separate CLI version `0.1.0`. Windows, Linux, Intel Mac, registry publication, and a public Homebrew tap are not included in this candidate.

`heaplens-cli` is the proposed npm name, not a published or reserved package. The proposed tap is `sachinkg12/homebrew-heaplens`, giving the future command `brew install sachinkg12/heaplens/heaplens`. Neither install command is public until the publication steps below are completed. Do not publish the repository's root package.json; that manifest belongs to the VS Code extension.

npm is a cross-platform package manager, but this candidate contains native Apple Silicon executables and explicitly restricts installation to that target. Other platforms require their own native builds and installed-package tests before the public npm command can support them.

The shipped package README comes from [package/README.md](package/README.md). The builder copies it to the root of each generated package as `README.md`. This maintainer guide is not bundled into the application.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `launcher.cjs` | Delegate headless commands to Rust; supply installed paths and the current Node executable for browser mode; forward termination to the owned process group |
| `files.cjs` | Validate configuration and native bytes; stage new files and calculate their inventory |
| `licenses.cjs` | Preserve license and notice texts for the target's resolved non-dev Rust dependencies |
| `homebrew.cjs` | Generate the Homebrew formula and its installation test |
| `build.cjs` | Compose the runtime and produce the npm archive, portable archive, checksums, and formulas |
| `smoke.cjs` | Install the actual npm tarball in a fresh temporary prefix and test it outside the source checkout |

The distribution adapter does not alter the analyzer, RPC protocol, browser host, or IDE implementations. It uses the existing shared browser build as an input. No installation hook downloads binaries or reports installations. Native binaries and browser assets are already inside the package. Homebrew supplies Node; npm uses an existing native ARM64 Node installation.

## Node compatibility

The manifest, launcher, and package README require Node.js 22 or newer. Node.js 20 is end-of-life. On an older Node, npm reports the manifest's engine mismatch at install time (`EBADENGINE`, a hard failure only when `engine-strict` is configured) and the launcher refuses to run with exit code 2. See the [Node.js release status](https://nodejs.org/en/about/previous-releases).

The candidate workflow builds on Node 22, then a separate matrix job downloads the candidate artifact and runs the installed smoke suite on Node 22 and on Node 24. Each run installs the npm archive with that version's npm into an isolated prefix, so the two smoke reports are evidence for both supported lines. The report records the exact Node version that ran it. Keep the manifest, launcher, package README, and workflow matrix consistent when the minimum changes again.

## Build a candidate

Use native ARM64 Node on Apple Silicon. A Node process running under Rosetta reports `x64` and npm will correctly reject this ARM64-only package.

From the repository root:

```sh
npm ci
cargo build --locked --release --bin heaplens --bin hprof-server --manifest-path hprof-analyzer/Cargo.toml
node browser-ui/build.cjs
cargo fetch --locked --target aarch64-apple-darwin --manifest-path hprof-analyzer/Cargo.toml
node --test scripts/distribution/distribution.test.cjs
CLI_CANDIDATE_DIR=$(mktemp -d /private/tmp/heaplens-cli-candidate.XXXXXX)
node scripts/distribution/build.cjs --out "$CLI_CANDIDATE_DIR"
node scripts/distribution/smoke.cjs "$CLI_CANDIDATE_DIR"
```

The output directory must be empty and outside the checkout. Both executables must contain Apple Silicon Mach-O bytes, and the native CLI version must match `config.json`. `cargo metadata` runs offline against the tracked `Cargo.lock`, so the locked graph must be fetched first: a release build downloads only what the two binaries need, while the metadata call resolves every package in the lockfile for the target, including dev-dependencies. On a fresh checkout, skipping `cargo fetch` fails packaging with a download error. Missing dependency notices fail packaging. Symlinks are not accepted as package inputs. The source commit, dirty-worktree flag, file inventory, and SHA-256 checksums preserve provenance; a dirty local candidate is not a clean release.

The output contains:

- `heaplens-cli-0.1.0.tgz` for a local npm install or later npm publication.
- `heaplens-cli-0.1.0-darwin-arm64.tar.gz` for the portable bundle and Homebrew.
- `homebrew/heaplens.rb` with a checksum and the proposed `cli-v0.1.0` release URL.
- `homebrew-local/heaplens.rb` pointing at this local candidate for maintainer testing only.
- `SHA256SUMS`, `candidate.json`, and, after a successful smoke run, `smoke-report.json`.

The separate candidate workflow builds from its checkout on an architecture-checked runner and uploads the candidate as an artifact. A second job then installs that artifact and runs the smoke suite on Node 22 and Node 24, uploading one smoke report per version. Those jobs have read-only repository permissions and no publication credentials. They run manually or for matching pull-request changes; merging alone does not publish a CLI package or tap. Only an exact `cli-vMAJOR.MINOR.PATCH` tag adds the release gates and the publish job described below.

## Test a local npm install

The smoke script automatically uses an isolated temporary prefix, disables telemetry, generates synthetic dumps, and tests help, version, analysis, HeapQL, comparison, JSON export, overwrite rejection, browser startup, authenticated browser analysis/query, and process cleanup. It never opens or uploads a user's dump.

For manual testing, substitute the actual candidate directory returned by the build:

```sh
CLI_TEST_PREFIX=$(mktemp -d /private/tmp/heaplens-cli-test.XXXXXX)
npm install --global --prefix "$CLI_TEST_PREFIX" --offline --ignore-scripts --no-audit --no-fund \
  "$CLI_CANDIDATE_DIR/heaplens-cli-0.1.0.tgz"
"$CLI_TEST_PREFIX/bin/heaplens" --help
"$CLI_TEST_PREFIX/bin/heaplens" analyze "/absolute/path/app.hprof" --telemetry off
"$CLI_TEST_PREFIX/bin/heaplens" open "/absolute/path/app.hprof" --source-root "/absolute/path/project/src" --telemetry off
```

No global npm installation or shell-profile change is needed for this test. The browser launch URL is private to the session. Keep it out of shared screenshots and logs. Ctrl+C must stop the browser host and its analysis servers.

## Validate Homebrew

Formula generation and Ruby syntax are automated checks. A real Homebrew installation is a separate acceptance test because it changes the normal Homebrew installation and may install Node. Do not equate syntax validation with an installed Homebrew pass.

For the acceptance test, copy `homebrew-local/heaplens.rb` into `Formula/heaplens.rb` of a disposable local tap, register that tap with `brew tap <owner>/<tap> <local-tap-path>`, and install the fully qualified formula. Run `brew test <owner>/<tap>/heaplens`, check `heaplens --help`, then analyze and open a known local dump. Remove only that test formula and tap when finished; do not remove dependencies already used by other applications. The public tap must use `homebrew/heaplens.rb`, never the local file URL.

If Homebrew rejects the installed Command Line Tools before installing HeapLens, fix that system prerequisite first and rerun installation. Do not interpret a subsequent missing `heaplens` command or a test requiring installation as an application crash. Update the tools through Apple's supported installation methods; deleting the developer-tools directory is not a packaging test step.

## Publish after acceptance

### One-time setup, by hand

1. Create the public `sachinkg12/homebrew-heaplens` tap repository. Add a fine-grained GitHub token limited to that repository's contents (read and write) as the `HOMEBREW_TAP_TOKEN` secret of this repository.
2. Publish the first version from the maintainer's npm account, because trusted publishing can only be configured on an existing package: `npm publish <candidate-tarball> --access public`. Then, in the package settings on npmjs.com, add a trusted publisher for GitHub Actions with the user `sachinkg12`, the repository `heaplens`, the workflow file `cli-package.yml` and no environment, allowed for `npm publish`. Two-factor authentication is required on the account.
3. Record the source commit and checksums of that manually published package for the first coordinated release baseline. A hand-created bootstrap GitHub release and formula are optional: the next automated CLI release creates its GitHub release assets and tap formula after testing them. The tap repository and its scoped token must already exist.

### Every later release, by tag

1. Use [coordinated preparation](../ci/README.md#coordinated-release-preparation) to update all three host versions and generate release notes. CLI configuration, the analyzer manifest and Cargo lockfile stay consistent because the packager checks the native `heaplens --version`. The crate version remains part of the disk-index namespace, so new engine packages start new index directories; installed hosts keep theirs until updating. The prepare command does not publish anything.
2. Merge the reviewed release PR, wait for successful CI on that exact main commit, then use the local tag command's preflight and explicit `--execute` mode to create all three host tags at that SHA. Ordinary merges do not auto-release VS Code. Prerelease or malformed tags do not publish.
3. The workflow runs the candidate build, the Node 22 and Node 24 installed smoke runs, the boundary tests and the full Rust suite on an Apple Silicon runner. `publish-cli` then runs `scripts/ci/release-cli.cjs`, the only job with `contents: write` and `id-token: write`, in this order:
   - bind the tag to the candidate, configuration and crate versions, the tagged commit and a clean worktree, and verify `SHA256SUMS`;
   - regenerate a local-file formula for the downloaded archive (the candidate's `homebrew-local` formula names the build runner's temporary directory), install it from a disposable tap, run `brew test` and `heaplens --help`, then remove that tap;
   - create the GitHub release `cli-v...` with the portable archive, the npm archive and `SHA256SUMS`, or complete an existing one whose assets match byte for byte;
   - download the portable archive from the public release URL and compare its checksum, then install and test the public formula from a second disposable tap;
   - publish the npm archive with trusted publishing, or skip it when the registry already has this version with the same integrity;
   - write the public formula to the tap through the GitHub contents API, or skip it when the tap already serves the identical formula.
   A GitHub asset, npm version or tap formula that exists with different content stops the job for a person to resolve, and a tag older than the version the tap already serves is refused rather than written. Publications run one at a time across tags. Reruns resume the remaining steps.
4. After publication, confirm the real install commands in the user documentation and configure aggregate download statistics against the published identifiers. npm downloads and Homebrew install events are different metrics, not unique people or an additive user total.

macOS signing/notarization and clean-machine Gatekeeper acceptance remain separate release checks; a successful workflow run is not evidence that downloaded binaries clear those checks.

## Engineering learnings

The source CLI's browser default refers to a build-time checkout path. Installed distribution therefore needs an explicit host adapter: the wrapper supplies `--ui-host`, `--server`, and `--node` from the installed runtime while preserving explicit overrides. This resolves deployment coupling without adding package-manager behavior to the analysis engine.

A Rust binary alone is sufficient for headless analysis but not for the browser host, which also requires Node, generated assets, host modules, and the shared telemetry contract. An explicit file allowlist ships these dependencies while excluding IDE code, development tools, dumps, and credentials.

OS/CPU metadata and native-byte checks serve different purposes. npm and Homebrew metadata prevents an unsupported normal install; Mach-O validation prevents an incorrectly labelled binary from entering the archive. Installed smoke testing adds evidence for path relocation, exports, local browser behavior, and termination. These checks do not establish other-platform support or the correctness of AI diagnoses.

A precompiled application does not bypass the package manager's environment checks. The first manual Homebrew installation stopped at an unsupported Command Line Tools check. After the user installed Command Line Tools 26.2 with a valid package receipt, the installation and formula test passed. Installer prerequisites and application runtime failures therefore need separate validation records.

The package README is a build input as well as user documentation. Keeping its source at `package/README.md` gives it the conventional name at the root of the package template without changing the installed layout. Its inclusion belongs in the packaging contract tests; repository Markdown policy remains a separate control.

## Local candidate validation

On October 10, 2026, the local dirty-worktree candidate based on commit `8a67e8a` passes an isolated npm installation using native ARM64 Node 24.19.0. The installed package passes headless analysis, HeapQL, comparison, JSON export, refusal to overwrite existing files, missing-input handling, authenticated browser analysis/query, and owned-process termination. The smoke checks that all eleven view labels are present; this is not a manual visual or every-action acceptance pass.

The existing suites also pass: 43 boundary tests including 12 new distribution contracts, 90 VS Code tests, and 23 browser host/telemetry regressions against the packaged server. Compile and lint complete with seven existing warnings and no errors. These results come from local tests, not a remote workflow run.

The original tested portable archive SHA-256 is `56805e7aa68c8ecaf18a121cc6d3cc5fc16ecb8d37726685a5b52e8885458c6f`. The original npm and portable archives are each approximately 4.3 MiB. These values identify the candidate tested before the package README move; rebuilt archives have their own checksums.

After the package README move, a fresh candidate was rebuilt on the same date and passed the isolated installed-package smoke again, including browser analysis/query and termination cleanup, with zero stderr bytes. The shipped README matches `package/README.md`, and all 43 boundary tests pass. The new portable archive SHA-256 is `72a76f24114b6b28226be7822b010792d16347cf6129a3f774b194148be62b12`. Browser testing required loopback access outside the restricted execution sandbox. This rerun did not repeat the real Homebrew installation or the user's manual acceptance checks.

After the minimum was raised to Node.js 22 on the same date, a fresh dirty-worktree candidate based on commit `8a67e8a` was rebuilt with `engines.node` set to `>=22` (portable archive SHA-256 `8b21afd4adbec66e315170a1431bd4125da8435f3a83e8085e1bcb221a28c765`). Separate copies of that candidate passed the isolated installed smoke suite on native ARM64 Node 22.23.3 with npm 10.9.9 and on Node 24.21.0 with npm 11.19.0, each including browser analysis/query and termination cleanup with zero stderr bytes; the reports record the Node version that ran them. On Node 20.20.2, npm printed the `EBADENGINE` warning for `>=22`, and the launcher run directly refused with "HeapLens CLI requires Node.js 22 or newer." and exit code 2. The only Node 20 build available locally was an Intel binary, so that install attempt also failed on the platform check, as documented above. These are local results; the matrix job in the candidate workflow has not yet run remotely.

On the same date, the user reported that the local npm installation, real-fixture analysis, HeapQL, JSON export, browser startup, and terminal shutdown checks passed. The user then supplied successful output from `brew test heaplens/local-test/heaplens`: installed help, version `0.1.0`, and synthetic JSON analysis all completed. The user subsequently confirmed the Homebrew browser check. The Homebrew test used a local tap on Apple Silicon macOS 26.2, with Command Line Tools 26.2 and Homebrew Node 26.11.0. This manual installation changed the normal Homebrew environment; the automated npm smoke used an isolated temporary prefix.

This establishes basic local installation and runtime acceptance, not every action in every tab. Remote workflow execution, installation from the public registry and release URL, clean-machine delivery, signing/notarization acceptance, external AI calls, and actual Azure delivery remain unverified. Telemetry was disabled in these tests. The test procedures did not publish an npm package or public tap or change product Git history. Rebuild and rerun the installed smoke after changing packaging inputs; preserve the manual results as evidence for the original candidate rather than attributing them to a new archive.

References: [npm package manifests](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/), [Homebrew formulas](https://docs.brew.sh/Formula-Cookbook), [Homebrew taps](https://docs.brew.sh/Taps), and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
