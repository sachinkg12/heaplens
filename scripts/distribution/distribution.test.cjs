'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandIndex, launchPlan } = require('./launcher.cjs');
const { configuration, appleSilicon, inventory, write } = require('./files.cjs');
const { dependencyNotices } = require('./licenses.cjs');
const { homebrewFormula } = require('./homebrew.cjs');
const config = require('./config.json');
const yaml = require('js-yaml');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-distribution-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function installation(t) {
  const root = temporary(t);
  write(root, 'package.json', JSON.stringify({ os: ['darwin'], cpu: ['arm64'] }));
  write(root, 'runtime/bin/heaplens', 'test executable');
  return root;
}
const apple = { platform: 'darwin', arch: 'arm64', node: '/trusted/node with spaces' };
test('packaged headless commands delegate unchanged with no shell interpolation', t => {
  const root = installation(t), args = ['query', '/private/path with spaces.hprof', 'SELECT "$(touch nope)" FROM instances'];
  const plan = launchPlan(root, args, apple);
  assert.deepEqual(plan.args, args);
  assert.equal(plan.executable, path.join(root, 'runtime/bin/heaplens'));
});
test('browser defaults resolve inside the installation rather than a developer checkout', t => {
  const root = installation(t), args = ['--telemetry', 'off', 'open', '/dump with spaces.hprof', '--no-browser'];
  const plan = launchPlan(root, args, apple);
  assert.deepEqual(plan.args, ['--telemetry', 'off', 'open', '--node', apple.node,
    '--ui-host', path.join(root, 'runtime/browser-ui/server.cjs'), '--server', path.join(root, 'runtime/bin/hprof-server'),
    '/dump with spaces.hprof', '--no-browser']);
  assert.deepEqual(args, ['--telemetry', 'off', 'open', '/dump with spaces.hprof', '--no-browser']);
});
test('explicit trusted host and executable overrides are preserved', t => {
  const root = installation(t), args = ['open', 'dump.hprof', '--ui-host=/trusted/ui.cjs', '--node', '/trusted/node', '--server', '/trusted/server'];
  assert.deepEqual(launchPlan(root, args, apple).args, args);
});
test('option values named open do not accidentally become browser commands', () => {
  assert.equal(commandIndex(['--output', 'open', 'analyze', 'heap.hprof']), 2);
  assert.equal(commandIndex(['--backend=indexed', 'open', 'heap.hprof']), 1);
  assert.equal(commandIndex(['--help']), -1);
  assert.equal(commandIndex(['unknown', 'open']), -1);
});
test('unsupported platforms are rejected before starting the native binary', t => {
  const root = installation(t);
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'x64'], ['linux', 'arm64'], ['linux', 'x64']])
    assert.throws(() => launchPlan(root, ['--help'], { platform, arch }), /Apple Silicon/);
});
test('configuration rejects unsupported targets and formula or package name injection', () => {
  assert.equal(configuration(config).version, '0.1.0');
  for (const change of [{ target: 'linux-x64' }, { version: '0.1.0"\n' }, { repository: 'owner/repo"' },
    { npm_name: '../heaplens' }, { npm_name: '$(command)' }, { npm_name: 'x'.repeat(215) }])
    assert.throws(() => configuration({ ...config, ...change }), /configuration/);
});
test('native byte validation rejects Intel, ELF, short files and symlinks', t => {
  const root = temporary(t), file = path.join(root, 'heaplens'), data = Buffer.alloc(32);
  data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(0x0100000c, 4); fs.writeFileSync(file, data);
  assert.deepEqual(appleSilicon(file), data);
  const link = path.join(root, 'symlink'); fs.symlinkSync(file, link);
  assert.throws(() => appleSilicon(link), /regular files/);
  for (const bad of [Buffer.alloc(3), Buffer.from('ELF not Mach-O'), Buffer.from(data)]) {
    if (bad.length === 32) bad.writeUInt32LE(0x01000007, 4);
    fs.writeFileSync(file, bad); assert.throws(() => appleSilicon(file), /Mach-O/);
  }
});
test('file staging never overwrites existing content and inventory rejects symlinks', t => {
  const root = temporary(t); write(root, 'runtime/secret.cjs', 'first');
  assert.throws(() => write(root, 'runtime/secret.cjs', 'replacement'), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(root, 'runtime/secret.cjs'), 'utf8'), 'first');
  assert.equal(inventory(root)[0].sha256.length, 64);
  fs.symlinkSync('/outside', path.join(root, 'link')); assert.throws(() => inventory(root), /symlink/);
});
test('dependency notices retain upstream text and include normal and build dependencies but not dev-only dependencies', t => {
  const root = temporary(t), destination = path.join(root, 'stage'); fs.mkdirSync(destination);
  const packages = ['root', 'normal', 'build', 'dev'].map(name => {
    const dir = path.join(root, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'LICENSE.txt'), 'upstream notice ' + name);
    return { id: name, name, version: '1.0.0', manifest_path: path.join(dir, 'Cargo.toml'), license_file: null, license: 'MIT' };
  });
  const metadata = { packages, resolve: { root: 'root', nodes: [{ id: 'root', deps: [
    { pkg: 'normal', dep_kinds: [{ kind: null }] }, { pkg: 'build', dep_kinds: [{ kind: 'build' }] }, { pkg: 'dev', dep_kinds: [{ kind: 'dev' }] }
  ] }] } };
  assert.deepEqual(dependencyNotices(metadata, destination).map(pkg => pkg.name), ['normal', 'build']);
  assert.equal(fs.readFileSync(path.join(destination, 'licenses/rust/normal-1.0.0/LICENSE.txt'), 'utf8'), 'upstream notice normal');
  fs.unlinkSync(path.join(root, 'normal/LICENSE.txt'));
  assert.throws(() => dependencyNotices(metadata, path.join(root, 'other-stage')), /Missing bundled/);
});
test('Homebrew adapter uses its own CLI release namespace and no publication commands', () => {
  const source = homebrewFormula(config, 'heaplens-cli-0.1.0-darwin-arm64.tar.gz', 'a'.repeat(64));
  assert.match(source, /releases\/download\/cli-v0\.1\.0\//);
  assert.match(source, /depends_on arch: :arm64/); assert.match(source, /depends_on "node"/);
  assert.match(source, /chmod 0755/);
  assert.match(source, /Telemetry is on by default/); assert.match(source, /DO_NOT_TRACK/);
  assert.doesNotMatch(source, /post_install|npm install|curl|wget|git push/);
  assert.throws(() => homebrewFormula(config, 'file', 'bad'), /formula/);
});
test('distribution code stays additive and is excluded from the VSIX', () => {
  const root = path.resolve(__dirname, '../..');
  assert.match(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'), /^scripts\/$/m);
  const launcher = fs.readFileSync(path.join(__dirname, 'launcher.cjs'), 'utf8');
  assert.doesNotMatch(launcher, /https?:\/\/|require\(['"]vscode|fetch\(/);
  assert.match(launcher, /< 22\) \{/); assert.match(launcher, /Node\.js 22 or newer/);
  const builder = fs.readFileSync(path.join(__dirname, 'build.cjs'), 'utf8');
  assert.match(builder, /engines: \{ node: '>=22' \}/);
  assert.match(builder, /require\('\.\/licenses\.cjs'\)/);
  assert.match(builder, /require\('\.\/homebrew\.cjs'\)/);
  assert.doesNotMatch(builder, /class |function homebrewFormula|function dependencyNotices/);
  assert.match(builder, /path\.join\(__dirname, 'package', 'README\.md'\)/);
  assert.doesNotMatch(builder, /package-README\.md/);
  const packageReadme = fs.readFileSync(path.join(__dirname, 'package', 'README.md'), 'utf8');
  assert.match(packageReadme, /macOS Apple Silicon/);
  assert.match(packageReadme, /Telemetry is enabled by default/);
  assert.match(packageReadme, /Node\.js 22 or newer/); assert.doesNotMatch(packageReadme, /Node\.js 20/);
});
test('standalone workflow builds candidates with read-only credentials and cannot publish either IDE', () => {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, '.github/workflows/cli-package.yml'), 'utf8');
  const workflow = yaml.load(source);
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs['apple-silicon-candidate']['runs-on'], 'macos-14');
  assert.equal(workflow.jobs['apple-silicon-candidate'].env.DO_NOT_TRACK, '1');
  assert.equal(workflow.jobs['apple-silicon-candidate'].steps[0].with['persist-credentials'], false);
  const candidate = workflow.jobs['apple-silicon-candidate'], installed = workflow.jobs['installed-package-test'];
  assert.equal(candidate.steps.find(step => step.uses?.startsWith('actions/setup-node')).with['node-version'], 22);
  assert.doesNotMatch(JSON.stringify(candidate.steps), /smoke\.cjs/); // The installed suite runs per Node version below.
  assert.equal(installed.needs, 'apple-silicon-candidate');
  assert.equal(installed['runs-on'], 'macos-14');
  assert.deepEqual(installed.strategy.matrix.node, [22, 24]);
  assert.equal(installed.steps[0].with['persist-credentials'], false);
  assert.equal(installed.env.DO_NOT_TRACK, '1');
  assert.match(JSON.stringify(installed.steps), /download-artifact@v4.*heaplens-cli-darwin-arm64-candidate.*smoke\.cjs/);
  assert.match(source, /scripts\/distribution\/smoke\.cjs/);
  assert.doesNotMatch(source, /secrets\.|npm publish|git push|npm version|publishPlugin|gh release|contents: write|id-token: write/);
});
