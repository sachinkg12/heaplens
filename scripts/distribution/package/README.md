# HeapLens standalone CLI

Analyze a local Java heap dump without installing an IDE extension. This candidate includes the native CLI, analysis server, and browser UI for macOS Apple Silicon. Windows, Linux, and Intel Macs are not supported by this candidate. npm itself is cross-platform; the native executables bundled here are not.

The package requires Node.js 22 or newer, running natively as ARM64. The installed package is tested on Node.js 22 and 24. See the [Node.js release status](https://nodejs.org/en/about/previous-releases). An Intel Node process running under Rosetta cannot install this ARM64-only npm package.

HeapLens itself does not require a source checkout, Rust compiler, JVM, or IDE to analyze an existing dump. Homebrew supplies Node and checks its own system prerequisites; npm uses an existing Node installation.

## Installation status

This is a local release candidate, not a package already available from the public npm registry or a public Homebrew tap. Public install commands will be provided after publication. Maintainers can follow the standalone packaging guide in the source repository to install the generated local archives.

## Run an analysis

```sh
heaplens analyze "/absolute/path/app.hprof"
heaplens query "/absolute/path/app.hprof" "SELECT class_name, retained_size FROM instances ORDER BY retained_size DESC LIMIT 20"
heaplens compare "/absolute/path/baseline.hprof" "/absolute/path/current.hprof"
```

Use `--format json --output "/absolute/path/new-report.json"` to export a headless report. Output files must be new; existing files are not overwritten.

## Open the browser UI

```sh
heaplens open "/absolute/path/app.hprof" --source-root "/absolute/path/project/src"
```

Keep the terminal running. The UI listens on loopback only. The printed URL grants access to this session; do not share it. Ctrl+C stops the launcher and its owned processes. Use `--no-browser` to print the URL without opening a browser automatically.

The browser provides the existing eleven views, exports, HeapQL, object navigation, local source viewing, and configured AI assistance. Source navigation uses the supplied local folders; the standalone package does not include dependency-JAR lookup or an IDE decompiler. Live monitoring also requires a separately configured compatible JVM agent. Packaging does not remove analysis memory requirements.

## Privacy and telemetry

Telemetry is enabled by default, using the existing bounded event contract. Disable it with `--telemetry off` or `DO_NOT_TRACK=1`; CI also disables it. Diagnostics exclude dump contents, source text, queries, credentials, and stable user identifiers. Network services may process IP addresses.

```sh
heaplens analyze "/absolute/path/app.hprof" --telemetry off
DO_NOT_TRACK=1 heaplens open "/absolute/path/app.hprof"
```

AI is optional. Configure a provider in the browser UI. Requests can disclose names and user-entered text; source submission requires explicit approval and sends the approved file in full. Provider credentials last for the browser session and are not installed in this package. Review proposals before applying changes.

The package has no installation hook, runtime package downloader, or installation tracking beacon. npm and Homebrew may collect their own distribution statistics under their respective policies. Third-party notices are bundled alongside the application license.
