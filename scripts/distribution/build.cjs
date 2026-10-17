'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const ASSETS = ['index.html', 'providers.json', 'system-prompt.txt', 'fix-system-prompt.txt', 'prompts.cjs'];
const RUNTIME = ['server', 'sources', 'session', 'rpc', 'guards', 'object-actions', 'consent-actions', 'source-actions',
  'ai-actions', 'ai', 'snapshot-actions', 'export-actions', 'monitor-actions', 'monitor', 'telemetry-actions', 'progressive-actions', 'waste-actions'];
const { configuration, readRegular, appleSilicon, write, inventory, digest } = require('./files.cjs');
const { dependencyNotices } = require('./licenses.cjs');
const { homebrewFormula } = require('./homebrew.cjs');
function build({ out, config, root = ROOT, binaries = path.join(root, 'hprof-analyzer/target/release'), assets = path.join(root, 'browser-ui/build'), metadata }) {
  config = configuration(config);
  if (typeof out !== 'string' || !path.isAbsolute(out)) throw Error('Use an absolute output directory.');
  // Never delete, overwrite or publish from the source tree.
  if (!fs.lstatSync(out).isDirectory() || fs.readdirSync(out).length) throw Error('Output directory must be new and empty.');
  out = fs.realpathSync(out); root = fs.realpathSync(root);
  if (out === root || out.startsWith(root + path.sep)) throw Error('Build candidates outside the source checkout.');
  const cli = appleSilicon(path.join(binaries, 'heaplens'));
  const server = appleSilicon(path.join(binaries, 'hprof-server'));
  const nativeVersion = execFileSync(path.join(binaries, 'heaplens'), ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  if (nativeVersion !== 'heaplens ' + config.version) throw Error('CLI version must match the packaged native executable.');
  const stage = path.join(out, 'heaplens-cli'); fs.mkdirSync(stage);
  const manifest = { name: config.npm_name, version: config.version,
    description: 'Standalone Java heap dump analysis with a native CLI and local browser UI', license: 'Apache-2.0',
    bin: { heaplens: 'bin/heaplens.cjs' }, os: ['darwin'], cpu: ['arm64'], engines: { node: '>=22' },
    repository: { type: 'git', url: 'https://github.com/' + config.repository },
    files: ['bin/', 'runtime/', 'licenses/', 'distribution.json', 'THIRD_PARTY_NOTICES.json', 'LICENSE', 'README.md'],
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' } };
  write(stage, 'package.json', JSON.stringify(manifest, null, 2) + '\n');
  write(stage, 'bin/heaplens.cjs', readRegular(path.join(__dirname, 'launcher.cjs')), 0o755);
  write(stage, 'runtime/bin/heaplens', cli, 0o755);
  write(stage, 'runtime/bin/hprof-server', server, 0o755);
  for (const name of RUNTIME) write(stage, 'runtime/browser-ui/' + name + '.cjs', readRegular(path.join(root, 'browser-ui', name + '.cjs')));
  for (const name of ASSETS) write(stage, 'runtime/browser-ui/build/' + name, readRegular(path.join(assets, name)));
  for (const name of ['node.cjs', 'contract.cjs', 'contract.json']) write(stage, 'runtime/telemetry/' + name, readRegular(path.join(root, 'telemetry', name)));
  write(stage, 'runtime/package.json', JSON.stringify({ version: config.version }) + '\n');
  write(stage, 'LICENSE', readRegular(path.join(root, 'LICENSE')));
  write(stage, 'README.md', readRegular(path.join(__dirname, 'package', 'README.md')));
  write(stage, 'licenses/d3-LICENSE.txt', readRegular(path.join(__dirname, 'd3-LICENSE.txt')));
  const dependencies = dependencyNotices(metadata, stage);
  write(stage, 'THIRD_PARTY_NOTICES.json', JSON.stringify({
    d3: { version: '7.9.0', license: 'ISC', source: 'https://github.com/d3/d3/tree/v7.9.0', notice: 'licenses/d3-LICENSE.txt' },
    rust: dependencies
  }, null, 2) + '\n');
  const source_commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const source_dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim();
  write(stage, 'distribution.json', JSON.stringify({ schema_version: 1, version: config.version, target: config.target,
    source_commit, source_dirty, files: inventory(stage) }, null, 2) + '\n');
  const filename = `heaplens-cli-${config.version}-${config.target}.tar.gz`;
  const archive = path.join(out, filename);
  execFileSync('tar', ['-czf', archive, '-C', out, 'heaplens-cli'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const hash = digest(fs.readFileSync(archive));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-pack-cache-'));
  let packed;
  try {
    packed = JSON.parse(execFileSync('npm', ['pack', stage, '--ignore-scripts', '--json', '--pack-destination', out, '--cache', cache],
      { encoding: 'utf8', cwd: out, maxBuffer: 8 * 1024 * 1024 }))[0];
  } finally {
    fs.rmSync(cache, { recursive: true, force: true }); // Only this packaging run's fresh npm cache.
  }
  const npmArchive = path.join(out, path.basename(packed.filename));
  write(out, 'SHA256SUMS', `${hash}  ${filename}\n${digest(fs.readFileSync(npmArchive))}  ${path.basename(npmArchive)}\n`);
  write(out, 'homebrew/heaplens.rb', homebrewFormula(config, filename, hash));
  write(out, 'homebrew-local/heaplens.rb', homebrewFormula(config, filename, hash, pathToFileURL(archive).href));
  const result = { version: config.version, target: config.target, npm_name: config.npm_name,
    portable_archive: filename, npm_archive: path.basename(npmArchive), sha256: hash, source_commit, source_dirty };
  write(out, 'candidate.json', JSON.stringify(result, null, 2) + '\n');
  return result;
}
function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--out', '--config', '--binaries', '--assets'].includes(argv[i]) || !argv[i + 1] || options[argv[i]]) throw Error('Invalid build arguments.');
    options[argv[i]] = argv[i + 1];
  }
  const config = JSON.parse(readRegular(options['--config'] || path.join(__dirname, 'config.json')));
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--offline', '--locked', '--format-version', '1',
    '--filter-platform', 'aarch64-apple-darwin', '--manifest-path', path.join(ROOT, 'hprof-analyzer/Cargo.toml')],
    { maxBuffer: 32 * 1024 * 1024 }));
  console.log(JSON.stringify(build({ out: options['--out'], config, metadata,
    ...(options['--binaries'] ? { binaries: options['--binaries'] } : {}),
    ...(options['--assets'] ? { assets: options['--assets'] } : {}) }), null, 2));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error('Standalone packaging failed: ' + error.message); process.exitCode = 1; }
}
module.exports = { build };
