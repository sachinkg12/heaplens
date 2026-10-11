'use strict';
// Build-time attribution only. Reuse the distribution license collector, never runtime code.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {dependencyNotices} = require('../../scripts/distribution/licenses.cjs');
const {readRegular, write} = require('../../scripts/distribution/files.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(__dirname, '../build/generated/notices');

function stage(destination, metadata, version) {
  // Only replace this task's fixed generated-output directory, never an arbitrary CLI path.
  if (path.resolve(destination) !== output) throw new Error('Unexpected notice output directory');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version || '')) throw new Error('Expected release version for attribution paths');
  if (fs.existsSync(output) && !fs.lstatSync(output).isDirectory()) throw new Error('Notice output must be a directory');
  fs.rmSync(output, {recursive: true, force: true});
  fs.mkdirSync(output, {recursive: true});
  write(output, 'LICENSE', readRegular(path.join(root, 'LICENSE')));
  write(output, 'licenses/d3-LICENSE.txt', readRegular(path.join(root, 'scripts/distribution/d3-LICENSE.txt')));
  const rust = dependencyNotices(metadata, output);
  write(output, 'THIRD_PARTY_NOTICES.json', JSON.stringify({
    d3: {version: '7.9.0', license: 'ISC', source: 'https://github.com/d3/d3/tree/v7.9.0', notice: 'licenses/d3-LICENSE.txt'},
    java: [
      {name: 'Gson', version: '2.13.1', license: 'Apache-2.0', source: 'https://github.com/google/gson/tree/gson-parent-2.13.1', notice: `lib/heaplens-intellij-${version}.jar!/META-INF/THIRD-PARTY-NOTICES.txt`},
      {name: 'Error Prone annotations', version: '2.38.0', license: 'Apache-2.0', source: 'https://github.com/google/error-prone/tree/v2.38.0', notice: `lib/heaplens-intellij-${version}.jar!/META-INF/THIRD-PARTY-NOTICES.txt`}
    ], rust
  }, null, 2) + '\n');
  console.log(`Staged project license, D3/Java notices and ${rust.length} Rust dependency notices`);
}
if (require.main === module) {
  const destination = process.argv[2];
  if (!destination || path.resolve(destination) !== output) throw new Error('Unexpected notice output directory');
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--offline', '--locked', '--format-version', '1',
    '--filter-platform', 'aarch64-apple-darwin', '--manifest-path', path.join(root, 'hprof-analyzer/Cargo.toml')],
    {maxBuffer: 32 * 1024 * 1024}));
  stage(destination, metadata, process.argv[3]);
}
module.exports = {stage};
