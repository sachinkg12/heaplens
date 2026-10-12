---
title: Develop the documentation site
---

HeapLens documentation is published to GitHub Pages from the `docs-site` directory. The site uses Docusaurus 3.9.2 and requires Node.js 22 or newer. These prerequisites are for working on the website, not for using the installed IDE plugin.

## Run locally

From the repository root:

```bash
cd docs-site
npm ci
npm start
```

The development server displays local changes. Edit documentation under `docs-site/docs`; add each new page to `sidebars.ts`. Keep existing routes stable so saved links continue to work.

## Check and build

Run from `docs-site`:

```bash
npm run check:contracts
npm run test:checks
npm run typecheck
npm run build
npm run check:links
npm run serve
```

The checks validate page registration, code examples and documented API fields. The production build and link check catch missing routes and fragments. The local search index is generated from documentation pages during the build.

To run documented native-server examples, first build the server from the repository root:

```bash
cargo build --locked --release --manifest-path hprof-analyzer/Cargo.toml --bin hprof-server
```

Then run from `docs-site`:

```bash
npm run check:examples -- --server ../hprof-analyzer/target/release/hprof-server
```

## Publishing

The documentation workflow validates pull requests without publishing. A successful eligible push to `main`, or an explicit main-branch workflow dispatch, builds and deploys the static site to GitHub Pages. Use this workflow for deployment. Product package publication is independent.

## Content and visual components

Use professional language and descriptive titles. Keep guides focused on installation, actions, reference information, privacy and useful limitations. Preserve the conditions and dates attached to recorded measurements. Do not turn a screenshot or illustrative example into a measured performance claim.

`FlowDiagram` provides diagrams with arrows, Play/Pause and reduced-motion support; it does not execute heap analysis. `ReferenceExample` illustrates reference connections separately from domination. Use these existing components rather than adding a second diagram runtime. The site uses local search and does not need remote fonts, an external visual CDN or a hosted search provider. Regenerate the social-preview PNG after changing its SVG source.

See [contributor setup](./contributing.md), [system architecture](./system-overview.md) and [support](../runbook/support.md).
