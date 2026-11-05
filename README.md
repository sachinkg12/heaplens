# HeapLens — Java & Android Heap Dump Analyzer

**Understand what your JVM is retaining, follow the references, and investigate without leaving your workflow.**

[![Install from VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Install-007ACC)](https://marketplace.visualstudio.com/items?itemName=guptasachinn.heaplens)
[![Open VSX Version](https://img.shields.io/open-vsx/v/guptasachinn/heaplens?label=Open%20VSX)](https://open-vsx.org/extension/guptasachinn/heaplens)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/guptasachinn/heaplens?label=Open%20VSX%20downloads)](https://open-vsx.org/extension/guptasachinn/heaplens)
[![License](https://img.shields.io/github/license/sachinkg12/heaplens)](https://github.com/sachinkg12/heaplens/blob/main/LICENSE)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.19121302-blue)](https://doi.org/10.5281/zenodo.19121302)

[VS Code](https://marketplace.visualstudio.com/items?itemName=guptasachinn.heaplens) · [Open VSX](https://open-vsx.org/extension/guptasachinn/heaplens) · [IntelliJ IDEA](https://plugins.jetbrains.com/plugin/35004-heaplens) · [CLI & browser](https://sachinkg12.github.io/heaplens/docs/getting-started/standalone/) · [Documentation](https://sachinkg12.github.io/heaplens/)

HeapLens analyzes local `.hprof` files using a shared native Rust engine. Explore class histograms, retained objects, dominators, references and GC-root paths; query the heap with HeapQL; compare snapshots; and optionally ask an AI assistant for help. Heap analysis itself does not upload the dump and does not require an AI account.

![HeapLens usage reported across 72 countries and regions](https://raw.githubusercontent.com/sachinkg12/heaplens/main/media/heaplens-global-reach.png)

## Install where you work

| Interface | Install | Published platform scope |
| --- | --- | --- |
| **VS Code and compatible editors** | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=guptasachinn.heaplens), [Open VSX](https://open-vsx.org/extension/guptasachinn/heaplens), or a matching [VSIX](https://github.com/sachinkg12/heaplens/releases) | macOS Apple Silicon and Intel; Windows x64; Linux x64 |
| **IntelliJ IDEA** | [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/35004-heaplens) or a matching release ZIP | macOS Apple Silicon; IDEA 2026.1–2026.2 with JCEF |
| **Terminal and local browser** | [npm](https://www.npmjs.com/package/heaplens-cli), [Homebrew](https://github.com/sachinkg12/homebrew-heaplens), or a [portable archive](https://github.com/sachinkg12/heaplens/releases) | macOS Apple Silicon; npm/browser require native ARM64 Node.js 22+ |

VS Code requires **1.75 or newer**; individual AI integrations may need newer host APIs. Extensions bundle their native analysis server: users do not need to install Rust or build the engine. Remote editors need the package for the extension-host machine, not necessarily the laptop. Package availability is not a claim that every feature has been manually validated on every platform.

For the standalone package, choose one installer:

```bash
npm install --global heaplens-cli
# Or:
brew install sachinkg12/heaplens/heaplens
```

Then analyze in the terminal or open the local browser UI:

```bash
heaplens analyze "/absolute/path/app.hprof" --telemetry off
heaplens open "/absolute/path/app.hprof" --telemetry off
```

The browser runs on loopback, not a public upload service. Keep its terminal running; do not share its session URL. See [host selection](https://sachinkg12.github.io/heaplens/docs/getting-started/choose-host/) and [installation details](https://sachinkg12.github.io/heaplens/docs/getting-started/installation/).

## Start with a question

- **What is taking memory?** Sort Histogram or the retained-object list, then inspect the owning objects.
- **Why is this object still alive?** Follow referrers and a bounded GC-root path.
- **What changed between captures?** Use Compare and Timeline to inspect class and retention changes.
- **Can I inspect this with a query?** Use HeapQL, or ask AI Chat to suggest a query and click **Run Query** yourself.

A large retained set is a diagnostic lead, not proof of a leak. Object sizes use an estimated conventional JVM layout, and retained values can overlap.

![HeapLens heap analysis in the editor](https://raw.githubusercontent.com/sachinkg12/heaplens/main/media/screenshots/demo.gif)

## Choose analysis and storage

| Option | What to expect |
| --- | --- |
| **Full analysis — default** | Progress appears first; shallow Overview/Histogram results become available before references and retained analysis finish. Retained values appear only when calculated. |
| **Quick Scan** | Counts and shallow sizes without building the reference graph. Select **Analyze Retained** for graph-dependent investigation. Conventional HPROF 1.0.1/1.0.2 only. |
| **Memory storage — default** | Builds analysis structures in RAM for each new analysis. Usually the first option to try when sufficient memory is available. |
| **Disk-backed references** | Builds a private reusable structural index. Reopening verifies the dump/index and recomputes dominators. First construction can be slower; this is not a hard RAM limit. |
| **Calculate Waste** | Runs content analysis on demand: duplicate strings, empty/over-allocated collections and boxed primitives. Uncalculated Waste is not zero. |

In VS Code, use **HeapLens: Configure Analysis Storage**; in IntelliJ, use **Disk-backed references**. Close and reopen a dump after changing storage. The CLI uses `--storage memory` or `--storage disk`; add `--with-waste` to include Waste.

Completed disk indexes remain after closing the dump, contain sensitive metadata and are not encrypted. Keep the original dump. Time, RAM and disk needs depend on object/reference density, storage and cache state—not file size alone. See [resource guidance](https://sachinkg12.github.io/heaplens/docs/runbook/performance-tuning/) and [recorded measurements with their scope](https://sachinkg12.github.io/heaplens/docs/runbook/recorded-measurements/).

## Eleven views, one analysis engine

| View | Use it for |
| --- | --- |
| Overview | Heap totals, top retained objects and investigation starting points |
| Histogram | Class counts, shallow/retained sizes and instance browsing after full analysis |
| Dominator Tree | Retaining ownership, expandable children and object actions |
| Leak Suspects | Large retention candidates worth investigating—not automatic proof of a defect |
| Waste | On-demand estimates of duplicate strings and collection/boxing overhead |
| Source | Navigate to relevant Java source; resolution depends on the host |
| Query | Read-only HeapQL, query history and object-navigation commands |
| Compare | Class, suspect and available Waste differences between two captures |
| Timeline | Trends across multiple snapshots |
| Monitor | Live statistics from a separately configured compatible JVM agent |
| AI Chat | Optional heap explanations, follow-up questions and suggested queries |

Source lookup, credentials, exports and process lifecycle use host-specific adapters. Not every host exposes the same source/decompiler or AI integration. See the [view guides](https://sachinkg12.github.io/heaplens/docs/tabs-guide/overview-tab/).

## HeapQL: query the heap, not a SQL database

HeapQL supports the `instances`, `class_histogram`, `dominator_tree` and `leak_suspects` tables, selected aggregates, joins, subqueries and navigation commands. It is not unrestricted SQL.

Large individual objects by retained size:

```sql
SELECT object_id, class_name, retained_size
FROM instances
WHERE retained_size >= 1MB
ORDER BY retained_size DESC
LIMIT 20
```

Class-level rows (already aggregated):

```sql
SELECT class_name, instance_count, shallow_size, retained_size
FROM class_histogram
ORDER BY retained_size DESC
LIMIT 20
```

Use `:path ID`, `:refs ID`, `:children ID` and `:info ID` with an actual object ID from the current dump. `SUM(retained_size)` can double-count shared ownership; `COUNT(*)` on the histogram counts class rows, not object instances. `LIMIT` bounds returned rows, not necessarily computation.

[HeapQL reference and supported examples](https://sachinkg12.github.io/heaplens/docs/api-reference/heapql/)

## Optional AI assistance

Use **AI Chat** for JVM questions, heap-specific explanations and HeapQL suggestions. The built-in provider options include Anthropic, OpenAI, Gemini, DeepSeek, Mistral, Groq, xAI, Together AI, OpenRouter and Ollama. VS Code also offers its separate Copilot integration where supported.

- In VS Code, search Settings for `heaplens.llm`, then use **HeapLens: Set or Replace LLM API Key**. Credentials use the editor's SecretStorage.
- IntelliJ and browser have their own provider and credential controls; follow their setup guides.
- Suggested queries run only after an explicit **Run Query** click. Local query results are not silently forwarded to a model.
- Model explanations and repair suggestions can be wrong. Inspect the evidence and review any proposed source change.

AI metadata can contain class/field names and the text you type; it is not anonymized. Automatic context excludes raw heap strings and primitive field values. Approved source submissions have a separate explicit sharing step and can contain sensitive information. Ollama is local only when its endpoint and processing are local. MCP clients have a separate disclosure boundary.

[AI setup](https://sachinkg12.github.io/heaplens/docs/tabs-guide/ai-chat-tab/) · [AI privacy](https://sachinkg12.github.io/heaplens/docs/ai-integration/privacy/) · [MCP setup](https://sachinkg12.github.io/heaplens/docs/mcp/setup/)

## Generate a capture

```bash
# From a running JVM
jcmd <pid> GC.heap_dump "/absolute/path/app.hprof"

# Capture when the JVM runs out of heap
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=./heap.hprof
```

Capture permissions and target-JVM tooling are separate from opening an existing file. Full analysis supports its implemented Java/Android HPROF records; Quick Scan has the narrower format scope above. A format header alone does not certify every producer/runtime layout. See [heap dump fundamentals](https://sachinkg12.github.io/heaplens/docs/concepts/heap-dump-fundamentals/).

## Privacy and telemetry

Analysis is local. Optional AI sharing and routine telemetry are separate controls.

| Host | Telemetry control |
| --- | --- |
| VS Code / compatible editors | **HeapLens: Configure Telemetry → Off**. Editor-level telemetry permission also applies. Development/CI reporting is disabled. |
| IntelliJ | **Off until explicit approval**; use its Telemetry control to change the saved choice. |
| CLI / browser | Add `--telemetry off`, or set `DO_NOT_TRACK=1` before launch. |

VS Code and CLI/browser default to permitted usage and errors. Routine telemetry uses allowlisted event fields, not dump contents, source/query text, paths or credentials. Permitted VS Code usage includes pseudonymous SDK machine/session identifiers; these are not verified people. IntelliJ and standalone telemetry remain identity-free. Network services may process IP addresses and derive approximate location.

[Telemetry details and opt-outs](https://sachinkg12.github.io/heaplens/docs/runbook/telemetry/) · [IntelliJ privacy policy](https://sachinkg12.github.io/heaplens/docs/runbook/intellij-privacy-policy/)

## Documentation and support

[Quick start](https://sachinkg12.github.io/heaplens/docs/getting-started/quick-start/) · [Architecture](https://sachinkg12.github.io/heaplens/docs/architecture/system-overview/) · [Troubleshooting](https://sachinkg12.github.io/heaplens/docs/runbook/troubleshooting/) · [Report an issue](https://github.com/sachinkg12/heaplens/issues)

Downloads measure distribution, not unique people or organizations. Telemetry covers only reporting clients; an unobserved country does not mean HeapLens has no users there.

HeapLens is open source under [Apache 2.0](https://github.com/sachinkg12/heaplens/blob/main/LICENSE).
